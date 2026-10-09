export declare const ALLOWED_GIFU_ENDPOINTS: Set<string>;
export declare function fetchGifuEndpoint(endpoint: string): Promise<{ status: number; body: string }>;
