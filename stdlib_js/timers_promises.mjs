export const setTimeout = async (ms, options) => {
  let onAbort;
  return new Promise((resolve, reject) => {
    globalThis.setTimeout(resolve, ms);
    onAbort = () => reject(new Error(options?.signal?.reason));
    options?.signal?.addEventListener('abort', onAbort);
  }).finally(() => {
    options?.signal?.removeEventListener('abort', onAbort);
  });
};
