/**
 * Account Size Presets
 *
 * Use CONFIG_PROFILE=SMALL|MEDIUM|LARGE in .env to activate
 * Example: CONFIG_PROFILE=SMALL npm run dev
 *
 * Each preset includes optimized settings for that account size
 * Original bot defaults are preserved - presets only override when specified
 */
export interface ConfigPreset {
    name: string;
    description: string;
    settings: Record<string, string | number | boolean>;
}
export declare const PRESETS: Record<string, ConfigPreset>;
/**
 * Load preset from CONFIG_PROFILE environment variable
 * Returns merged settings (preset overrides default)
 */
export declare function loadPreset(profileName?: string): Record<string, string | number | boolean>;
/**
 * Override individual settings programmatically
 * Useful for testing or dynamic adjustments
 */
export declare function mergePreset(profileName: string, overrides: Record<string, string | number | boolean>): Record<string, string | number | boolean>;
/**
 * Apply preset to environment
 * Overwrites .env-derived values with preset values
 */
export declare function applyPreset(settings: Record<string, string | number | boolean>): void;
