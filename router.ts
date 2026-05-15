// protocols/example2.ts - Type-Safe Router Protocol for RheoMesh
// Inspired by tRPC but adapted for distributed mesh architecture

import { RheoCell as BaseCell } from "./core";
import type { TraceResult, Signal } from "./core";

// ============================================================================
// TYPE UTILITIES
// ============================================================================

/**
 * Extracts the input type from a procedure
 */
export type InferInput<T> = T extends Procedure<infer I, unknown> ? I : never;

/**
 * Extracts the output type from a procedure
 */
export type InferOutput<T> = T extends Procedure<unknown, infer O> ? O : never;

/**
 * Converts a procedure to its client-callable interface
 */
type InferProcedure<T> =
    T extends Procedure<infer I, infer O>
    ? I extends void
    ? { query: () => Promise<O>; mutate: () => Promise<O> }
    : { query: (input: I) => Promise<O>; mutate: (input: I) => Promise<O> }
    : T extends Router<infer P>
    ? { [K in keyof P]: InferProcedure<P[K]> }
    : never;

/**
 * Converts a router definition to a client-callable interface
 */
export type InferRouter<T> = T extends Router<infer TProcedures>
    ? { [K in keyof TProcedures]: InferProcedure<TProcedures[K]> }
    : never;

// ============================================================================
// SCHEMA SYSTEM (Runtime validation + Type inference)
// ============================================================================


abstract class ZodType<T> {
    _def: any = {};
    protected _defaultValue?: T;
    protected _optional = false;

    abstract parse(val: unknown): T;

    // PUBLIC GETTER for default value checking
    getDefault(): T | undefined {
        return this._defaultValue;
    }

    optional(): ZodOptional<T> {
        return new ZodOptional(this);
    }

    default(value: T): this {
        this._defaultValue = value;
        return this;
    }

    protected applyDefault(val: unknown): T | undefined {
        if (val === undefined && this._defaultValue !== undefined) {
            return this._defaultValue;
        }
        return val as T;
    }
}

class ZodString extends ZodType<string> {
    private _min?: number;
    private _max?: number;

    constructor() {
        super();
        this._def.typeName = "ZodString";
    }

    parse(val: unknown): string {
        const withDefault = this.applyDefault(val);
        if (withDefault !== undefined) return withDefault;
        if (typeof val !== 'string') throw new Error('Expected string');
        if (this._min !== undefined && val.length < this._min) {
            throw new Error(`String too short (min ${this._min})`);
        }
        if (this._max !== undefined && val.length > this._max) {
            throw new Error(`String too long (max ${this._max})`);
        }
        return val;
    }

    min(n: number): this {
        this._min = n;
        return this;
    }

    max(n: number): this {
        this._max = n;
        return this;
    }
}

class ZodNumber extends ZodType<number> {
    private _min?: number;
    private _max?: number;

    constructor() {
        super();
        this._def.typeName = "ZodNumber";
    }

    parse(val: unknown): number {
        const withDefault = this.applyDefault(val);
        if (withDefault !== undefined) return withDefault;
        if (typeof val !== 'number') throw new Error('Expected number');
        if (this._min !== undefined && val < this._min) {
            throw new Error(`Number too small (min ${this._min})`);
        }
        if (this._max !== undefined && val > this._max) {
            throw new Error(`Number too large (max ${this._max})`);
        }
        return val;
    }

    min(n: number): this {
        this._min = n;
        return this;
    }

    max(n: number): this {
        this._max = n;
        return this;
    }
}

class ZodBoolean extends ZodType<boolean> {
    constructor() {
        super();
        this._def.typeName = "ZodBoolean";
    }

    parse(val: unknown): boolean {
        const withDefault = this.applyDefault(val);
        if (withDefault !== undefined) return withDefault;
        if (typeof val !== 'boolean') throw new Error('Expected boolean');
        return val;
    }
}

class ZodLiteral<T extends string | number | boolean> extends ZodType<T> {
    constructor(private value: T) {
        super();
        this._def = { typeName: "ZodLiteral", value };
    }

    parse(val: unknown): T {
        if (val !== this.value) {
            throw new Error(`Expected literal: ${this.value}`);
        }
        return val as T;
    }
}

class ZodOptional<T> extends ZodType<T | undefined> {
    constructor(private inner: ZodType<T>) {
        super();
        this._def = { typeName: "ZodOptional", innerType: inner };
    }

    parse(val: unknown): T | undefined {
        if (val === undefined) return undefined;
        return this.inner.parse(val);
    }
}

class ZodObject<T extends Record<string, ZodType<any>>> extends ZodType<{
    [K in keyof T]: T[K] extends ZodType<infer U> ? U : never
}> {
    constructor(private shape: T) {
        super();
        this._def = { typeName: "ZodObject", shape: () => shape };
    }

    parse(val: unknown): any {
        if (typeof val !== 'object' || val === null) {
            throw new Error('Expected object');
        }
        const result: any = {};
        for (const [key, schema] of Object.entries(this.shape)) {
            const fieldVal = (val as any)[key];

            // Use public getter instead of protected property
            const defaultValue = schema.getDefault();
            const isOptional = schema instanceof ZodOptional;

            if (fieldVal === undefined && !isOptional) {
                // Check if schema has default using public getter
                if (defaultValue !== undefined) {
                    result[key] = defaultValue;
                } else {
                    throw new Error(`Missing required field: ${key}`);
                }
            } else if (fieldVal !== undefined) {
                result[key] = schema.parse(fieldVal);
            } else if (isOptional) {
                // Optional field with undefined value - skip it
                result[key] = undefined;
            }
        }
        return result;
    }
}

class ZodArray<T> extends ZodType<T[]> {
    constructor(private item: ZodType<T>) {
        super();
        this._def = { typeName: "ZodArray", item };
    }

    parse(val: unknown): T[] {
        if (!Array.isArray(val)) throw new Error('Expected array');
        return val.map(v => this.item.parse(v));
    }
}

class ZodEnum<T extends string> extends ZodType<T> {
    private values: readonly T[];

    constructor(values: readonly T[]) {
        super();
        this.values = [...values]; // Defensive copy
        this._def = { typeName: "ZodEnum", values: this.values };
    }

    parse(val: unknown): T {
        if (val === undefined || val === null) {
            throw new Error(`Expected enum value but got ${val}. Allowed: [${this.values.join(', ')}]`);
        }
        // Handle both string and enum values
        const strVal = typeof val === 'string' ? val : String(val);
        if (!this.values.includes(strVal as T)) {
            throw new Error(`Invalid value "${strVal}". Expected one of: [${this.values.join(', ')}]`);
        }
        return strVal as T;
    }
}

class ZodRecord<T> extends ZodType<Record<string, T>> {
    constructor(private valueSchema: ZodType<T>) {
        super();
        this._def = { typeName: "ZodRecord", valueType: valueSchema };
    }

    parse(val: unknown): Record<string, T> {
        if (typeof val !== 'object' || val === null || Array.isArray(val)) {
            throw new Error('Expected object map');
        }
        const result: Record<string, T> = {};
        for (const [k, v] of Object.entries(val)) {
            result[k] = this.valueSchema.parse(v);
        }
        return result;
    }
}

class ZodVoid extends ZodType<void> {
    constructor() {
        super();
        this._def.typeName = "ZodVoid";
    }
    parse(): void { return undefined; }
}

class ZodAny extends ZodType<any> {
    constructor() {
        super();
        this._def.typeName = "ZodAny";
    }
    parse(val: unknown): any { return val; }
}

// ============================================================================
// EXPORT z OBJECT
// ============================================================================

export const z = {
    string: () => new ZodString(),
    number: () => new ZodNumber(),
    boolean: () => new ZodBoolean(),
    literal: <T extends string | number | boolean>(value: T) => new ZodLiteral(value),
    enum: <T extends string>(values: readonly T[]) => new ZodEnum(values),
    object: <T extends Record<string, ZodType<any>>>(shape: T) => new ZodObject(shape),
    array: <T>(item: ZodType<T>) => new ZodArray(item),
    record: <T>(valueSchema: ZodType<T>) => new ZodRecord(valueSchema),
    optional: <T>(schema: ZodType<T>) => new ZodOptional(schema),
    void: () => new ZodVoid(),
    any: () => new ZodAny(),
};

// Type exports
export type Schema<T> = ZodType<T>;

// ============================================================================
// PROCEDURE BUILDER
// ============================================================================

export interface ProcedureMeta {
    description?: string;
    example?: any;
}

export class Procedure<TInput = void, TOutput = unknown> {
    public readonly _def: {
        input?: Schema<TInput>;
        output?: Schema<TOutput>;
        meta?: ProcedureMeta;
        type: 'query' | 'mutation';
        handler: (input: TInput, ctx: Signal) => Promise<TOutput>;
    };

    constructor(
        type: 'query' | 'mutation',
        input: Schema<TInput> | undefined,
        output: Schema<TOutput> | undefined,
        handler: (input: TInput, ctx: Signal) => Promise<TOutput>,
        meta?: ProcedureMeta
    ) {
        this._def = { type, input, output, handler, meta };
    }
}

class ProcedureBuilder<TInput, TOutput> {
    constructor(
        private _input?: Schema<TInput>,
        private _output?: Schema<TOutput>,
        private _meta?: ProcedureMeta
    ) { }

    /**
     * Add metadata/documentation to the procedure.
     * Can be called multiple times; properties are merged.
     */
    meta(meta: ProcedureMeta): ProcedureBuilder<TInput, TOutput> {
        return new ProcedureBuilder(
            this._input,
            this._output,
            { ...this._meta, ...meta }
        );
    }

    /**
     * Define the input schema (validation)
     */
    input<TNewInput>(schema: Schema<TNewInput>): ProcedureBuilder<TNewInput, TOutput> {
        return new ProcedureBuilder<TNewInput, TOutput>(
            schema,
            this._output,
            this._meta
        );
    }

    /**
     * Define the output schema (validation)
     */
    output<TNewOutput>(schema: Schema<TNewOutput>): ProcedureBuilder<TInput, TNewOutput> {
        return new ProcedureBuilder<TInput, TNewOutput>(
            this._input,
            schema,
            this._meta
        );
    }

    /**
     * Define a Query (read-only) operation
     */
    query(handler: (input: TInput, ctx: Signal) => Promise<TOutput>): Procedure<TInput, TOutput> {
        return new Procedure(
            'query',
            this._input,
            this._output,
            handler,
            this._meta
        );
    }

    /**
     * Define a Mutation (write) operation
     */
    mutation(handler: (input: TInput, ctx: Signal) => Promise<TOutput>): Procedure<TInput, TOutput> {
        return new Procedure(
            'mutation',
            this._input,
            this._output,
            handler,
            this._meta
        );
    }
}

/**
 * Procedure builder - start here to create endpoints
 */
export const procedure = new ProcedureBuilder<void, unknown>();

// ============================================================================
// ROUTER
// ============================================================================

export type AnyProcedure = Procedure<unknown, unknown>;
export type AnyRouter = Router<Record<string, AnyProcedure | AnyRouter>>;

export class Router<TProcedures extends Record<string, AnyProcedure | AnyRouter>> {
    public readonly _def: {
        procedures: TProcedures;
    };

    constructor(procedures: TProcedures) {
        this._def = { procedures };
    }

    /**
     * Get all capability paths this router provides
     */
    getCapabilities(prefix = ''): string[] {
        const caps: string[] = [];

        for (const [key, proc] of Object.entries(this._def.procedures)) {
            const path = prefix ? `${prefix}/${key}` : key;

            if (proc instanceof Router) {
                caps.push(...proc.getCapabilities(path));
            } else {
                caps.push(path);
            }
        }

        return caps;
    }

    /**
     * Find a procedure by its capability path
     */
    findProcedure(capability: string): AnyProcedure | null {
        const parts = capability.split('/');
        let current: AnyProcedure | AnyRouter | undefined = undefined;
        let currentProcs: Record<string, AnyProcedure | AnyRouter> = this._def.procedures;

        for (const part of parts) {
            current = currentProcs[part];
            if (!current) return null;

            if (current instanceof Router) {
                currentProcs = current._def.procedures;
            }
        }

        return current instanceof Procedure ? current : null;
    }

    /**
     * Get contract information for a capability
     * Returns the actual zod schemas that can be introspected
     */
    getContract(capability: string): { input?: any; output?: any; meta?: ProcedureMeta } | null {
        const proc = this.findProcedure(capability);
        if (!proc) return null;

        return {
            input: proc._def.input,
            output: proc._def.output,
            meta: proc._def.meta // <--- ADDED
        };
    }

    /**
     * Get all contracts from this router
     */
    getAllContracts(): Record<string, { input?: any; output?: any }> {
        const contracts: Record<string, { input?: any; output?: any }> = {};
        for (const cap of this.getCapabilities()) {
            const contract = this.getContract(cap);
            if (contract) contracts[cap] = contract;
        }
        return contracts;
    }
}

/**
 * Create a router
 */
export function router<T extends Record<string, AnyProcedure | AnyRouter>>(
    procedures: T
): Router<T> {
    return new Router(procedures);
}

// ============================================================================
// ENHANCED RHEO CELL WITH ROUTER SUPPORT
// ============================================================================

export class RheoCell extends BaseCell {
    private _router: AnyRouter | null = null;

    /**
     * Attach a typed router to this cell
     */
    useRouter<T extends AnyRouter>(router: T): void {
        this._router = router;

        // Register all capabilities from the router
        const capabilities = router.getCapabilities();

        for (const cap of capabilities) {
            this.provide(cap, async (args: unknown, ctx: Signal) => {
                const proc = router.findProcedure(cap);

                if (!proc) {
                    throw new Error(`Procedure not found: ${cap}`);
                }

                // Validate input if schema exists
                let validatedInput = args;
                if (proc._def.input) {
                    try {
                        validatedInput = proc._def.input.parse(args);
                    } catch (e: unknown) {
                        const error = e as Error;
                        throw new Error(`Input validation failed for ${cap}: ${error.message}`);
                    }
                }

                // Execute handler
                const start = Date.now();
                this.log('INFO', `⚙️  EXEC_START: [${cap}]`);
                const result = await proc._def.handler(validatedInput, ctx);
                this.log('INFO', `⚙️  EXEC_END: [${cap}] (${Date.now() - start}ms)`);
                return result;
            });
        }

        // ✅ AUTO-REGISTER CONTRACT ENDPOINT
        // This makes the schemas available to codegen
        this.provide("cell/contract", ({ cap }: { cap: string }) => {
            return router.getContract(cap) || null;
        });
    }

    /**
     * Get the router if attached
     */
    getRouter(): AnyRouter | null {
        return this._router;
    }
}

// ============================================================================
// CLIENT PROXY GENERATOR
// ============================================================================

/**
 * Creates a type-safe client proxy for calling mesh procedures
 */
export function createMeshClient<TRouter extends AnyRouter>(config: {
    fetchFn: (capability: string, args: unknown) => Promise<unknown>;
}): InferRouter<TRouter> {
    const { fetchFn } = config;

    function createProxy(path: string[] = []): unknown {
        return new Proxy(() => { }, {
            get(_target, prop: string) {
                return createProxy([...path, prop]);
            },

            apply(_target, _thisArg, args: unknown[]) {
                const capability = path.join('/');
                const input = args[0];

                return fetchFn(capability, input);
            },

            // Support for .query() and .mutate()
            has(_target, prop: string) {
                return prop === 'query' || prop === 'mutate';
            }
        });
    }

    return createProxy() as InferRouter<TRouter>;
}

// ============================================================================
// TYPE EXPORT HELPERS
// ============================================================================

/**
 * Helper to export router type from a cell
 */
export type RouterType<T extends { _def: { procedures: Record<string, AnyProcedure | AnyRouter> } }> = T;

/**
 * Helper to infer the full client interface from a cell's router
 */
export type ClientFromRouter<T> = T extends AnyRouter ? InferRouter<T> : never;



// --- Typed mesh ---

