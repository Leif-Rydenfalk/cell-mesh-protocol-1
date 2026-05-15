// protocols/typed-mesh.ts - Fully Type-Safe Cross-Cell Communication
// This protocol provides 100% compile-time type safety for mesh calls
import { RheoCell as BaseCell, MeshError } from "./core";
// ============================================================================
// TYPED RHEO CELL
// ============================================================================
/**
 * Type-safe extension of RheoCell
 * Provides compile-time verification of all mesh calls
 */
export class TypedRheoCell extends BaseCell {
    _router = null;
    /**
    * Type-safe mesh call with exponential backoff retry.
    * - Validates capability exists at compile time
    * - Validates input matches expected schema
    * - Returns typed output
    * - Retries with exponential backoff if capability not found
    */
    async askMesh(capability, input, options = {}) {
        const startTime = Date.now();
        const timeout = options.maxWaitMs ?? 30000;
        let attempt = 0;
        while (Date.now() - startTime < timeout) {
            const result = await super.askMesh(capability, input);
            if (result.ok)
                return result;
            // NEW: Check for specific "recoverable" errors
            if (result.error?.code === "NOT_FOUND") {
                // Actively hunt for the capability instead of just waiting
                await this.bootstrapFromRegistry(true);
                // Exponential backoff so we don't DOS the mesh
                await new Promise(r => setTimeout(r, Math.min(100 * Math.pow(2, attempt), 2000)));
                attempt++;
                continue;
            }
            // If it's a validation or logic error, GIVE UP. Re-trying won't fix bad code.
            throw new MeshError(result.error, result.cid);
        }
        throw new Error(`Mesh Timeout: Capability [${capability}] never appeared.`);
    }
    /**
     * Attach a typed router and auto-register contract endpoint
     */
    useRouter(router) {
        this._router = router;
        // Register all capabilities from the router
        const capabilities = router.getCapabilities();
        for (const cap of capabilities) {
            const proc = router.findProcedure(cap);
            if (!proc) {
                throw new Error(`Procedure not found: ${cap}`);
            }
            // Register the handler
            this.provide(cap, async (args, ctx) => {
                // DEBUG: Log what we received
                if (process.env.RHEO_DEBUG_INPUT) {
                    console.log(`[DEBUG] ${cap} received args:`, JSON.stringify(args, null, 2));
                }
                let validatedInput = args;
                if (proc._def.input) {
                    try {
                        validatedInput = proc._def.input.parse(args);
                    }
                    catch (e) {
                        const error = e;
                        // Include actual received args in error for debugging
                        throw new Error(`Input validation failed for ${cap}: ${error.message} | Received: ${JSON.stringify(args).substring(0, 200)}`);
                    }
                }
                return await proc._def.handler(validatedInput, ctx);
            });
        }
        // ✅ AUTO-REGISTER CONTRACT ENDPOINT
        // This makes the schemas available to codegen
        this.provide("cell/contract", ({ cap }) => {
            const contract = router.getContract(cap);
            return contract || null;
        });
        this.log("INFO", `📋 Registered ${capabilities.length} capabilities with contracts`);
    }
    /**
     * Get the router if attached
     */
    getRouter() {
        return this._router;
    }
    /**
     * Proxy-based API for more ergonomic calls
     * Usage: cell.mesh.ai.generate({ prompt: "..." })
     */
    get mesh() {
        return createMeshProxy(this);
    }
}
/**
 * Create the mesh proxy for ergonomic calls
 */
function createMeshProxy(cell) {
    return new Proxy({}, {
        get(_target, namespace) {
            return new Proxy({}, {
                get(_subTarget, procedure) {
                    return async (input) => {
                        const capability = `${namespace}/${procedure}`;
                        cell.log('INFO', `🔗 PROXY_CALL: [${capability}]`);
                        const result = await cell.askMesh(capability, input !== undefined ? input : {});
                        if (!result.ok) {
                            throw new Error(`Mesh call failed: ${capability}\n` +
                                `Error: ${result.error?.msg || 'Unknown error'}`);
                        }
                        return result.value;
                    };
                }
            });
        }
    });
}
// ============================================================================
// ROUTER REGISTRATION HELPER
// ============================================================================
/**
 * Register a router and augment the type system
 * This helper makes it easier for cells to register their capabilities
 */
export function registerRouter(cell, router, options) {
    // Register with the base cell (runtime)
    cell.useRouter(router);
    // Type augmentation happens automatically via codegen
}
// ============================================================================
// CAPABILITY VALIDATOR (Optional runtime validation)
// ============================================================================
/**
 * Runtime validator to ensure mesh state matches types
 * Useful during development to catch capability mismatches
 */
export class CapabilityValidator {
    static expectedCapabilities = new Set();
    static registerExpected(capabilities) {
        capabilities.forEach(cap => this.expectedCapabilities.add(cap));
    }
    static async validateMesh(cell) {
        // Get actual capabilities from mesh
        const healthResult = await cell.askMesh("mesh/health", {});
        if (!healthResult.ok) {
            return { missing: [], unexpected: [] };
        }
        // Gather all capabilities from atlas
        const actualCapabilities = new Set();
        for (const entry of Object.values(cell.atlas)) {
            entry.caps.forEach(cap => actualCapabilities.add(cap));
        }
        const missing = Array.from(this.expectedCapabilities)
            .filter(cap => !actualCapabilities.has(cap));
        const expected = Array.from(this.expectedCapabilities);
        const unexpected = Array.from(actualCapabilities)
            .filter(cap => !expected.includes(cap));
        return { missing, unexpected };
    }
}
