(function () {
  const formatters = new Map();

  function getFormatter(minFractionDigits = 0, maxFractionDigits = 0) {
    const key = `${minFractionDigits}:${maxFractionDigits}`;
    if (!formatters.has(key)) {
      formatters.set(
        key,
        new Intl.NumberFormat('de-DE', {
          minimumFractionDigits: minFractionDigits,
          maximumFractionDigits: maxFractionDigits
        })
      );
    }
    return formatters.get(key);
  }

  /**
   * Formats numeric candy balances with dot separators (1.000, 1.000.000)
   * @param {number|string} value
   * @param {{decimals?: number}} options
   * @returns {string}
   */
  function formatCoins(value, options = {}) {
    const decimals = Number.isInteger(options.decimals) ? options.decimals : 0;
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return getFormatter(decimals, decimals).format(0);
    }
    return getFormatter(decimals, decimals).format(num);
  }

  function formatCandy(value, options) {
    return `${formatCoins(value, options)} 🍬`;
  }

  function formatSignedCandy(value, options) {
    const num = Number(value) || 0;
    if (num === 0) {
      return formatCandy(0, options);
    }
    const sign = num > 0 ? '+' : '-';
    return `${sign}${formatCandy(Math.abs(num), options)}`;
  }

  window.formatCoins = formatCoins;
  window.formatCandy = formatCandy;
  window.formatSignedCandy = formatSignedCandy;
})();

