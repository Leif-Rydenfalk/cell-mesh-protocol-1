// protocols/browser-shim.ts
// Polyfills for Node.js APIs so protocols work in browser

// Polyfill node:crypto
if (typeof window !== 'undefined') {
    const browserCrypto = {
        randomUUID: () => crypto.randomUUID(),
        createHash: (algorithm: string) => {
            return {
                update: (data: any) => browserCrypto.createHash(algorithm),
                digest: (encoding: string) => Math.random().toString(36).substring(2, 18)
            };
        },
        generateKeyPairSync: () => {
            const dummyKey = {
                export: () => `-----BEGIN PUBLIC KEY-----\n${btoa('dummy')}\n-----END PUBLIC KEY-----`
            };
            return { publicKey: dummyKey, privateKey: dummyKey };
        },
        sign: () => Buffer.from('dummy'),
        verify: () => true,
        createPublicKey: (key: string) => ({ export: () => key })
    };

    const globalCrypto = (globalThis as any).crypto || {};
    (globalThis as any).crypto = {
        ...globalCrypto,
        ...browserCrypto
    };
}

// Polyfill node:fs (no-ops for browser)
const dummyFs = {
    writeFileSync: () => { },
    readFileSync: () => '{}',
    existsSync: () => false,
    mkdirSync: () => { },
    statSync: () => ({ mtimeMs: Date.now() }),
    readdirSync: () => [],
    unlinkSync: () => { },
    appendFileSync: () => { }
};

// Polyfill node:path
const dummyPath = {
    join: (...args: string[]) => args.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
    resolve: (...args: string[]) => args.join('/')
};

// Polyfill node:child_process
const dummyChild = {
    spawn: () => ({ unref: () => { }, pid: 0 })
};

// Polyfill node:os
const dummyOs = {
    loadavg: () => [0, 0, 0],
    homedir: () => '/tmp' // <-- Add homedir polyfill so the registry path doesn't crash the browser
};

// Export polyfills for browser imports
export const crypto = (globalThis as any).crypto;
export const fs = dummyFs;
export const path = dummyPath;
export const child_process = dummyChild;
export const os = dummyOs;
export const http = { createServer: () => ({}) };