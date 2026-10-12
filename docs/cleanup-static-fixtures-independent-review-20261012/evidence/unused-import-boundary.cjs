/* Unused application/provider dependencies are refused, never executed. */
const targets = new Map();
module.exports = new Proxy({ __esModule: true }, {
  get(target, name) {
    if (name in target) return target[name];
    if (!targets.has(name)) targets.set(name, function refusedDependency() {
      throw new Error(`Unused application/provider dependency invoked: ${String(name)}`);
    });
    return targets.get(name);
  },
});
