"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tenantFeatureEnabled = tenantFeatureEnabled;
/** Canonical, fail-closed per-tenant boolean feature reader. */
function tenantFeatureEnabled(settings, flag, defaultValue) {
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
        const flags = settings.clioFeatureFlags;
        if (flags && typeof flags === 'object' && !Array.isArray(flags)) {
            const value = flags[flag];
            if (typeof value === 'boolean')
                return value;
        }
    }
    return defaultValue;
}
//# sourceMappingURL=tenant-feature.js.map