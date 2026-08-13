declare const __BROLLY_RELEASE__: string;

export const BROLLY_RELEASE = typeof __BROLLY_RELEASE__ === "string" ? __BROLLY_RELEASE__ : "development";
