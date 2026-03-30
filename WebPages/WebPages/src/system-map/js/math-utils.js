/**
 * Math utilities and polyfills for the Telemachus 3D Map.
 * Extracted from Houston's 3dmap.js and modernized.
 */

Math.toDegrees = function(angleInRadians) {
  return angleInRadians * (180 / Math.PI);
};

Math.toRadians = function(angleInDegrees) {
  return angleInDegrees * (Math.PI / 180);
};

Math.crossProduct = function(x, y) {
  return [
    x[1] * y[2] - x[2] * y[1],
    x[2] * y[0] - x[0] * y[2],
    x[0] * y[1] - x[1] * y[0]
  ];
};

Math.sign = Math.sign || function(x) {
  x = +x; // convert to a number
  if (x === 0 || isNaN(x)) {
    return x;
  }
  return x > 0 ? 1 : -1;
};

Math.cosh = Math.cosh || function(x) {
  return (Math.exp(x) + Math.exp(-x)) / 2;
};

Math.sinh = Math.sinh || function(x) {
  return (Math.exp(x) - Math.exp(-x)) / 2;
};

Math.matrixAdd = Math.matrixAdd || function() {
  var arrays = arguments, results = [],
    count, L = arrays.length,
    sum, next = 0, i;
  if (L === 0 || !arrays[0]) return [];
  count = arrays[0].length;
  if (count === undefined) return [];
  
  while (next < count) {
    sum = 0, i = 0;
    while (i < L) {
      if (arrays[i] && arrays[i][next] !== undefined) {
        sum += Number(arrays[i++][next]);
      } else {
        i++;
      }
    }
    results[next++] = sum;
  }
  return results;
};

Math.scaleMatrix = Math.scaleMatrix || function(factor, matrix) {
  var result = [], count = matrix.length, next = 0;
  while (next < count) {
    result[next] = factor * matrix[next];
    next++;
  }
  return result;
};

/**
 * Time formatting utilities from Houston.
 */
const TimeFormatters = {
  formatUT: function(t) {
    var day, year;
    if (t == null) {
      t = 0;
    }
    year = ((t / (365 * 24 * 3600)) | 0) + 1;
    t %= 365 * 24 * 3600;
    day = ((t / (24 * 3600)) | 0) + 1;
    t %= 24 * 3600;
    return "Year " + year + ", Day " + day + ", " + (this.hourMinSec(t)) + " UT";
  },

  formatMET: function(t) {
    var result;
    if (t == null) {
      t = 0;
    }
    result = "T+";
    if (t >= 365 * 24 * 3600) {
      result += (t / (365 * 24 * 3600) | 0) + ":";
      t %= 365 * 24 * 3600;
      if (t < 24 * 3600) {
        result += "0:";
      }
    }
    if (t >= 24 * 3600) {
      result += (t / (24 * 3600) | 0) + ":";
    }
    t %= 24 * 3600;
    return result + this.hourMinSec(t) + " MET";
  },

  hourMinSec: function(t) {
    var hour, min, sec;
    if (t == null) {
      t = 0;
    }
    hour = (t / 3600) | 0;
    if (hour < 10) {
      hour = "0" + hour;
    }
    t %= 3600;
    min = (t / 60) | 0;
    if (min < 10) {
      min = "0" + min;
    }
    sec = (t % 60 | 0).toFixed();
    if (sec < 10) {
      sec = "0" + sec;
    }
    return "" + hour + ":" + min + ":" + sec;
  },

  durationString: function(t) {
    var result;
    if (t == null) {
      t = 0;
    }
    result = t < 0 ? "-" : "";
    t = Math.abs(t);
    if (t >= 365 * 24 * 3600) {
      result += (t / (365 * 24 * 3600) | 0) + " years ";
      t %= 365 * 24 * 3600;
      if (t < 24 * 3600) {
        result += "0 days ";
      }
    }
    if (t >= 24 * 3600) {
      result += (t / (24 * 3600) | 0) + " days ";
    }
    t %= 24 * 3600;
    return result + this.hourMinSec(t);
  }
};

/**
 * Basic number formatting (lite replacement for numeral.js).
 */
const DataFormatters = {
  distanceString: function(value) {
    if (!value) return "0m";
    if (value > 1000000) return (value / 1000000).toFixed(3) + " Mm";
    if (value > 1000) return (value / 1000).toFixed(3) + " km";
    return value.toFixed(3) + " m";
  },

  speedString: function(value) {
    if (!value) return "0 m/s";
    return value.toFixed(3) + " m/s";
  },

  degreeString: function(value) {
    if (!value) return "0°";
    return value.toFixed(3) + "°";
  }
};

window.TimeFormatters = TimeFormatters;
window.DataFormatters = DataFormatters;
