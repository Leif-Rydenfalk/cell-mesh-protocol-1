// protocols/example2.ts - Type-Safe Router Protocol for RheoMesh
// Inspired by tRPC but adapted for distributed mesh architecture
import { RheoCell as BaseCell } from "./core";
// ============================================================================
// SCHEMA SYSTEM (Runtime validation + Type inference)
// ============================================================================
class ZodType {
    _def = {};
    _defaultValue;
    _optional = false;
    // PUBLIC GETTER for default value checking
    getDefault() {
        return this._defaultValue;
    }
    optional() {
        return new ZodOptional(this);
    }
    default(value) {
        this._defaultValue = value;
        return this;
    }
    applyDefault(val) {
        if (val === undefined && this._defaultValue !== undefined) {
            return this._defaultValue;
        }
        return val;
    }
}
class ZodString extends ZodType {
    _min;
    _max;
    constructor() {
        super();
        this._def.typeName = "ZodString";
    }
    parse(val) {
        const parsed = this.applyDefault(val);
        if (parsed === undefined)
            throw new Error('Expected string');
        if (typeof parsed !== 'string')
            throw new Error('Expected string');
        if (this._min !== undefined && parsed.length < this._min) {
            throw new Error(`String too short (min ${this._min})`);
        }
        if (this._max !== undefined && parsed.length > this._max) {
            throw new Error(`String too long (max ${this._max})`);
        }
        return parsed;
    }
    min(n) {
        this._min = n;
        return this;
    }
    max(n) {
        this._max = n;
        return this;
    }
}
class ZodNumber extends ZodType {
    _min;
    _max;
    constructor() {
        super();
        this._def.typeName = "ZodNumber";
    }
    parse(val) {
        const parsed = this.applyDefault(val);
        if (parsed === undefined)
            throw new Error('Expected number');
        if (typeof parsed !== 'number')
            throw new Error('Expected number');
        if (this._min !== undefined && parsed < this._min) {
            throw new Error(`Number too small (min ${this._min})`);
        }
        if (this._max !== undefined && parsed > this._max) {
            throw new Error(`Number too large (max ${this._max})`);
        }
        return parsed;
    }
    min(n) {
        this._min = n;
        return this;
    }
    max(n) {
        this._max = n;
        return this;
    }
}
class ZodBoolean extends ZodType {
    constructor() {
        super();
        this._def.typeName = "ZodBoolean";
    }
    parse(val) {
        const parsed = this.applyDefault(val);
        if (parsed === undefined)
            throw new Error('Expected boolean');
        if (typeof parsed !== 'boolean')
            throw new Error('Expected boolean');
        return parsed;
    }
}
class ZodLiteral extends ZodType {
    value;
    constructor(value) {
        super();
        this.value = value;
        this._def = { typeName: "ZodLiteral", value };
    }
    parse(val) {
        if (val !== this.value) {
            throw new Error(`Expected literal: ${this.value}`);
        }
        return val;
    }
}
class ZodOptional extends ZodType {
    inner;
    constructor(inner) {
        super();
        this.inner = inner;
        this._def = { typeName: "ZodOptional", innerType: inner };
    }
    parse(val) {
        if (val === undefined)
            return undefined;
        return this.inner.parse(val);
    }
}
class ZodObject extends ZodType {
    shape;
    constructor(shape) {
        super();
        this.shape = shape;
        this._def = { typeName: "ZodObject", shape: () => shape };
    }
    parse(val) {
        if (typeof val !== 'object' || val === null) {
            throw new Error('Expected object');
        }
        const result = {};
        for (const [key, schema] of Object.entries(this.shape)) {
            const fieldVal = val[key];
            // Use public getter instead of protected property
            const defaultValue = schema.getDefault();
            const isOptional = schema instanceof ZodOptional;
            if (fieldVal === undefined && !isOptional) {
                // Check if schema has default using public getter
                if (defaultValue !== undefined) {
                    result[key] = defaultValue;
                }
                else {
                    throw new Error(`Missing required field: ${key}`);
                }
            }
            else if (fieldVal !== undefined) {
                result[key] = schema.parse(fieldVal);
            }
            else if (isOptional) {
                // Optional field with undefined value - skip it
                result[key] = undefined;
            }
        }
        return result;
    }
}
class ZodArray extends ZodType {
    item;
    constructor(item) {
        super();
        this.item = item;
        this._def = { typeName: "ZodArray", item };
    }
    parse(val) {
        if (!Array.isArray(val))
            throw new Error('Expected array');
        return val.map(v => this.item.parse(v));
    }
}
class ZodEnum extends ZodType {
    values;
    constructor(values) {
        super();
        this.values = [...values]; // Defensive copy
        this._def = { typeName: "ZodEnum", values: this.values };
    }
    parse(val) {
        if (val === undefined || val === null) {
            throw new Error(`Expected enum value but got ${val}. Allowed: [${this.values.join(', ')}]`);
        }
        // Handle both string and enum values
        const strVal = typeof val === 'string' ? val : String(val);
        if (!this.values.includes(strVal)) {
            throw new Error(`Invalid value "${strVal}". Expected one of: [${this.values.join(', ')}]`);
        }
        return strVal;
    }
}
class ZodRecord extends ZodType {
    valueSchema;
    constructor(valueSchema) {
        super();
        this.valueSchema = valueSchema;
        this._def = { typeName: "ZodRecord", valueType: valueSchema };
    }
    parse(val) {
        if (typeof val !== 'object' || val === null || Array.isArray(val)) {
            throw new Error('Expected object map');
        }
        const result = {};
        for (const [k, v] of Object.entries(val)) {
            result[k] = this.valueSchema.parse(v);
        }
        return result;
    }
}
class ZodVoid extends ZodType {
    constructor() {
        super();
        this._def.typeName = "ZodVoid";
    }
    parse() { return undefined; }
}
class ZodAny extends ZodType {
    constructor() {
        super();
        this._def.typeName = "ZodAny";
    }
    parse(val) { return val; }
}
// ============================================================================
// EXPORT z OBJECT
// ============================================================================
export const z = {
    string: () => new ZodString(),
    number: () => new ZodNumber(),
    boolean: () => new ZodBoolean(),
    literal: (value) => new ZodLiteral(value),
    enum: (values) => new ZodEnum(values),
    object: (shape) => new ZodObject(shape),
    array: (item) => new ZodArray(item),
    record: (valueSchema) => new ZodRecord(valueSchema),
    optional: (schema) => new ZodOptional(schema),
    void: () => new ZodVoid(),
    any: () => new ZodAny(),
};
export class Procedure {
    _def;
    constructor(type, input, output, handler, meta) {
        this._def = { type, input, output, handler, meta };
    }
}
class ProcedureBuilder {
    _input;
    _output;
    _meta;
    constructor(_input, _output, _meta) {
        this._input = _input;
        this._output = _output;
        this._meta = _meta;
    }
    /**
     * Add metadata/documentation to the procedure.
     * Can be called multiple times; properties are merged.
     */
    meta(meta) {
        return new ProcedureBuilder(this._input, this._output, { ...this._meta, ...meta });
    }
    /**
     * Define the input schema (validation)
     */
    input(schema) {
        return new ProcedureBuilder(schema, this._output, this._meta);
    }
    /**
     * Define the output schema (validation)
     */
    output(schema) {
        return new ProcedureBuilder(this._input, schema, this._meta);
    }
    /**
     * Define a Query (read-only) operation
     */
    query(handler) {
        return new Procedure('query', this._input, this._output, handler, this._meta);
    }
    /**
     * Define a Mutation (write) operation
     */
    mutation(handler) {
        return new Procedure('mutation', this._input, this._output, handler, this._meta);
    }
}
/**
 * Procedure builder - start here to create endpoints
 */
export const procedure = new ProcedureBuilder();
export class Router {
    _def;
    constructor(procedures) {
        this._def = { procedures };
    }
    /**
     * Get all capability paths this router provides
     */
    getCapabilities(prefix = '') {
        const caps = [];
        for (const [key, proc] of Object.entries(this._def.procedures)) {
            const path = prefix ? `${prefix}/${key}` : key;
            if (proc instanceof Router) {
                caps.push(...proc.getCapabilities(path));
            }
            else {
                caps.push(path);
            }
        }
        return caps;
    }
    /**
     * Find a procedure by its capability path
     */
    findProcedure(capability) {
        const parts = capability.split('/');
        let current = undefined;
        let currentProcs = this._def.procedures;
        for (const part of parts) {
            current = currentProcs[part];
            if (!current)
                return null;
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
    getContract(capability) {
        const proc = this.findProcedure(capability);
        if (!proc)
            return null;
        return {
            input: proc._def.input,
            output: proc._def.output,
            meta: proc._def.meta // <--- ADDED
        };
    }
    /**
     * Get all contracts from this router
     */
    getAllContracts() {
        const contracts = {};
        for (const cap of this.getCapabilities()) {
            const contract = this.getContract(cap);
            if (contract)
                contracts[cap] = contract;
        }
        return contracts;
    }
}
/**
 * Create a router
 */
export function router(procedures) {
    return new Router(procedures);
}
// ============================================================================
// ENHANCED RHEO CELL WITH ROUTER SUPPORT
// ============================================================================
export class RheoCell extends BaseCell {
    _router = null;
    /**
     * Attach a typed router to this cell
     */
    useRouter(router) {
        this._router = router;
        // Register all capabilities from the router
        const capabilities = router.getCapabilities();
        for (const cap of capabilities) {
            this.provide(cap, async (args, ctx) => {
                const proc = router.findProcedure(cap);
                if (!proc) {
                    throw new Error(`Procedure not found: ${cap}`);
                }
                // Validate input if schema exists
                let validatedInput = args;
                if (proc._def.input) {
                    try {
                        validatedInput = proc._def.input.parse(args);
                    }
                    catch (e) {
                        const error = e;
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
        this.provide("cell/contract", ({ cap }) => {
            return router.getContract(cap) || null;
        });
    }
    /**
     * Get the router if attached
     */
    getRouter() {
        return this._router;
    }
}
// ============================================================================
// CLIENT PROXY GENERATOR
// ============================================================================
/**
 * Creates a type-safe client proxy for calling mesh procedures
 */
export function createMeshClient(config) {
    const { fetchFn } = config;
    function createProxy(path = []) {
        return new Proxy(() => { }, {
            get(_target, prop) {
                return createProxy([...path, prop]);
            },
            apply(_target, _thisArg, args) {
                const capability = path.join('/');
                const input = args[0];
                return fetchFn(capability, input);
            },
            // Support for .query() and .mutate()
            has(_target, prop) {
                return prop === 'query' || prop === 'mutate';
            }
        });
    }
    return createProxy();
}
// --- Typed mesh ---
