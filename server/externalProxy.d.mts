export declare const EXTERNAL_SOURCES: Record<string, { origin: string; allow: (path: string) => boolean }>;
export declare function fetchExternal(sourceKey: string, path: string): Promise<{ status: number; body: string }>;
