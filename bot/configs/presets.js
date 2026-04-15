"use strict";
/**
 * Account Size Presets
 *
 * Use CONFIG_PROFILE=SMALL|MEDIUM|LARGE in .env to activate
 * Example: CONFIG_PROFILE=SMALL npm run dev
 *
 * Each preset includes optimized settings for that account size
 * Original bot defaults are preserved - presets only override when specified
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRESETS = void 0;
exports.loadPreset = loadPreset;
exports.mergePreset = mergePreset;
exports.applyPreset = applyPreset;
exports.PRESETS = {
    // ─── SMALL ACCOUNT: $20-$500 ───────────────────────────────────────────
    SMALL: {
        name: "SMALL",
        description: "Optimized for accounts under $500 (tight risk, frequent small trades)",
        settings: {
            // Position Sizing
            MIN_TRADE_SIZE_FLOOR: 5,
            MIN_TRADE_SIZE_PERCENT: 0.20, // 20% of equity
            // Risk Management
            MAX_DRAWDOWN_PERCENT: 0.10, // 10% hard stop
            MAX_POSITION_SIZE_PERCENT: 0.15, // 15% per trade
            MAX_DELTA_EXPOSURE: 0.05,
            // Capital Allocation
            LENDING_ALLOCATION_PERCENT: 0.50, // 50% trading, 50% lending
            // Trade Entry/Exit
            MIN_FUNDING_RATE_APR: 0.01, // 1% APR minimum
            MAX_HOLD_TIME_MINUTES: 180, // 3 hours max hold
            PROFIT_TARGET_PERCENT: 0.01, // 1% profit exit
            // Slippage
            MAX_SLIPPAGE_PERCENT: 0.002,
            ESTIMATED_FEE_PERCENT: 0.003,
            // Disable expensive features
            CROSS_CHAIN_ENABLED: false, // Bridges too expensive
            // Monitoring
            LOG_VERBOSITY: "NORMAL",
            TELEGRAM_ENABLED: true,
        },
    },
    // ─── MEDIUM ACCOUNT: $500-$5,000 ──────────────────────────────────────
    MEDIUM: {
        name: "MEDIUM",
        description: "Balanced for accounts $500-$5,000 (moderate risk, good opportunity window)",
        settings: {
            // Position Sizing
            MIN_TRADE_SIZE_FLOOR: 20,
            MIN_TRADE_SIZE_PERCENT: 0.10, // 10% of equity
            // Risk Management
            MAX_DRAWDOWN_PERCENT: 0.10, // 10% hard stop
            MAX_POSITION_SIZE_PERCENT: 0.20, // 20% per trade
            MAX_DELTA_EXPOSURE: 0.05,
            // Capital Allocation
            LENDING_ALLOCATION_PERCENT: 0.60, // 60% trading, 40% lending
            // Trade Entry/Exit
            MIN_FUNDING_RATE_APR: 0.005, // 0.5% APR minimum
            MAX_HOLD_TIME_MINUTES: 240, // 4 hours max hold
            PROFIT_TARGET_PERCENT: 0.015, // 1.5% profit exit
            // Slippage
            MAX_SLIPPAGE_PERCENT: 0.003,
            ESTIMATED_FEE_PERCENT: 0.0025,
            // Cross-chain with limits
            CROSS_CHAIN_ENABLED: true,
            MIN_CROSS_CHAIN_EDGE: 0.02, // 2% minimum for bridge cost
            // Monitoring
            LOG_VERBOSITY: "NORMAL",
            TELEGRAM_ENABLED: true,
        },
    },
    // ─── LARGE ACCOUNT: $5,000+ ───────────────────────────────────────────
    LARGE: {
        name: "LARGE",
        description: "Aggressive for accounts over $5,000 (higher capacity, optimize APR)",
        settings: {
            // Position Sizing
            MIN_TRADE_SIZE_FLOOR: 100,
            MIN_TRADE_SIZE_PERCENT: 0.05, // 5% of equity
            // Risk Management
            MAX_DRAWDOWN_PERCENT: 0.15, // 15% hard stop (more room)
            MAX_POSITION_SIZE_PERCENT: 0.30, // 30% per trade
            MAX_DELTA_EXPOSURE: 0.08,
            // Capital Allocation
            LENDING_ALLOCATION_PERCENT: 0.70, // 70% trading, 30% lending
            // Trade Entry/Exit
            MIN_FUNDING_RATE_APR: 0.003, // 0.3% APR minimum (lower threshold)
            MAX_HOLD_TIME_MINUTES: 360, // 6 hours max hold
            PROFIT_TARGET_PERCENT: 0.02, // 2% profit exit
            // Slippage
            MAX_SLIPPAGE_PERCENT: 0.005,
            ESTIMATED_FEE_PERCENT: 0.002,
            // Cross-chain enabled
            CROSS_CHAIN_ENABLED: true,
            MIN_CROSS_CHAIN_EDGE: 0.01, // 1% minimum for bridge cost
            // Monitoring
            LOG_VERBOSITY: "NORMAL",
            TELEGRAM_ENABLED: true,
        },
    },
    // ─── PRODUCTION: Enterprise/Vault Scale ───────────────────────────────
    PRODUCTION: {
        name: "PRODUCTION",
        description: "Conservative for large institutional vaults ($100k+, capital preservation)",
        settings: {
            // Position Sizing
            MIN_TRADE_SIZE_FLOOR: 500,
            MIN_TRADE_SIZE_PERCENT: 0.02, // 2% of equity
            // Risk Management
            MAX_DRAWDOWN_PERCENT: 0.08, // 8% hard stop (conservative)
            MAX_POSITION_SIZE_PERCENT: 0.15, // 15% per trade (cap at 15% despite equity size)
            MAX_DELTA_EXPOSURE: 0.03,
            // Capital Allocation
            LENDING_ALLOCATION_PERCENT: 0.80, // 80% lending, 20% trading (capital preservation)
            // Trade Entry/Exit
            MIN_FUNDING_RATE_APR: 0.005, // 0.5% APR minimum (higher bar for quality)
            MAX_HOLD_TIME_MINUTES: 240, // 4 hours strict hold limit
            PROFIT_TARGET_PERCENT: 0.01, // 1% profit exit (lock in gains)
            // Slippage
            MAX_SLIPPAGE_PERCENT: 0.002,
            ESTIMATED_FEE_PERCENT: 0.001,
            // Cross-chain disabled (use dedicated bridges)
            CROSS_CHAIN_ENABLED: false,
            // Monitoring (verbose for compliance)
            LOG_VERBOSITY: "NORMAL",
            TELEGRAM_ENABLED: true,
        },
    },
};
/**
 * Load preset from CONFIG_PROFILE environment variable
 * Returns merged settings (preset overrides default)
 */
function loadPreset(profileName) {
    const profile = profileName?.toUpperCase() || process.env.CONFIG_PROFILE?.toUpperCase() || "MEDIUM";
    const preset = exports.PRESETS[profile];
    if (!preset) {
        console.warn(`[CONFIG] Unknown profile: ${profile}. Available: ${Object.keys(exports.PRESETS).join(", ")}. Using MEDIUM.`);
        return exports.PRESETS.MEDIUM.settings;
    }
    console.log(`\n[CONFIG] Loaded preset: ${preset.name}`);
    console.log(`[CONFIG] Description: ${preset.description}\n`);
    return preset.settings;
}
/**
 * Override individual settings programmatically
 * Useful for testing or dynamic adjustments
 */
function mergePreset(profileName, overrides) {
    const preset = exports.PRESETS[profileName.toUpperCase()];
    if (!preset)
        throw new Error(`Unknown preset: ${profileName}`);
    return { ...preset.settings, ...overrides };
}
/**
 * Apply preset to environment
 * Overwrites .env-derived values with preset values
 */
function applyPreset(settings) {
    Object.entries(settings).forEach(([key, value]) => {
        if (process.env[key] === undefined) {
            process.env[key] = String(value);
        }
    });
}
//# sourceMappingURL=presets.js.map