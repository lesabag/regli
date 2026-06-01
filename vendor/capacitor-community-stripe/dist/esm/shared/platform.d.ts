/**
 * @url https://github.com/ionic-team/ionic-framework/blob/main/core/src/utils/platform.ts
 * So `@typescript-eslint/no-explicit-any` `@typescript-eslint/no-non-null-assertion` is disabled here
 */
export type Platforms = keyof typeof PLATFORMS_MAP;
interface IsPlatformSignature {
    (plt: Platforms): boolean;
    (win: Window, plt: Platforms): boolean;
}
export declare const getPlatforms: (win?: any) => Platforms[];
export declare const isPlatform: IsPlatformSignature;
export declare const setupPlatforms: (win?: any) => Platforms[];
export declare const testUserAgent: (win: Window, expr: RegExp) => boolean;
declare const PLATFORMS_MAP: {
    ipad: (win: Window) => boolean;
    iphone: (win: Window) => boolean;
    ios: (win: Window) => boolean;
    android: (win: Window) => boolean;
    phablet: (win: Window) => boolean;
    tablet: (win: Window) => boolean;
    cordova: (win: any) => boolean;
    capacitor: (win: any) => boolean;
    electron: (win: Window) => boolean;
    pwa: (win: Window) => boolean;
    mobile: (win: Window) => boolean;
    mobileweb: (win: Window) => boolean;
    desktop: (win: Window) => boolean;
    hybrid: (win: Window) => boolean;
};
export {};
