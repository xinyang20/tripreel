// Bounded, opt-in stage measurements for the isolated benchmark, never telemetry.
export function measureStage(name, operation) {
  const metrics = globalThis.__tripreelPerformance;
  if (!metrics) return operation();
  const start = performance.now();
  try {
    return operation();
  } finally {
    const values = (metrics[name] ||= []);
    if (values.length >= 2000) values.shift();
    values.push(performance.now() - start);
  }
}
export async function measureAsyncStage(name, operation) {
  const metrics = globalThis.__tripreelPerformance;
  if (!metrics) return operation();
  const start = performance.now();
  try {
    return await operation();
  } finally {
    const values = (metrics[name] ||= []);
    if (values.length >= 2000) values.shift();
    values.push(performance.now() - start);
  }
}
