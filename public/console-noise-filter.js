(() => {
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  const isSesNoise = (args) => {
    if (!args || args.length === 0) return false;
    const first = args[0];
    if (typeof first !== "string") return false;

    // MetaMask/SES "lockdown" often logs these with a null error payload.
    const isSesTag =
      first.includes("SES_UNCAUGHT_EXCEPTION") ||
      first.includes("SES_UNHANDLED_REJECTION") ||
      first.includes("SES_UNCAUGHT_REJECTION");

    if (!isSesTag) return false;

    // Keep it conservative: only suppress the super-noisy "…: null" cases.
    return args.length === 2 && (args[1] === null || args[1] === undefined);
  };

  console.error = (...args) => {
    if (isSesNoise(args)) return;
    originalError(...args);
  };

  console.warn = (...args) => {
    if (isSesNoise(args)) return;
    originalWarn(...args);
  };
})();

