const PDFDocument = require("pdfkit");

const CM_TO_PT = 72 / 2.54;

const CODE39 = Object.freeze({
  "0": "nnnwwnwnn",
  "1": "wnnwnnnnw",
  "2": "nnwwnnnnw",
  "3": "wnwwnnnnn",
  "4": "nnnwwnnnw",
  "5": "wnnwwnnnn",
  "6": "nnwwwnnnn",
  "7": "nnnwnnwnw",
  "8": "wnnwnnwnn",
  "9": "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  "$": "nwnwnwnnn",
  "/": "nwnwnnnwn",
  "+": "nwnnnwnwn",
  "%": "nnnwnwnwn",
  "*": "nwnnwnwnn",
});

function cmToPt(value) {
  return Number(value) * CM_TO_PT;
}

function parsePositiveNumber(value) {
  const normalized = String(value || "").replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeNumber(value) {
  const normalized = String(value || "").replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeBadgeForm(body = {}) {
  const firstCodeText = String(body.first_code || "").trim();
  const lastCodeText = String(body.last_code || "").trim();
  const totalText = String(body.total_badges || "").trim();

  return {
    firstCode: /^\d+$/.test(firstCodeText) ? Number(firstCodeText) : null,
    lastCode: /^\d+$/.test(lastCodeText) ? Number(lastCodeText) : null,
    totalBadges: /^\d+$/.test(totalText) ? Number(totalText) : null,
    badgeWidthCm: parsePositiveNumber(body.badge_width_cm),
    badgeHeightCm: parsePositiveNumber(body.badge_height_cm),
    barcodeWidthCm: parsePositiveNumber(body.barcode_width_cm),
    barcodeHeightCm: parsePositiveNumber(body.barcode_height_cm),
    barcodeXCm: parseNonNegativeNumber(body.barcode_x_cm),
    barcodeYCm: parseNonNegativeNumber(body.barcode_y_cm),
  };
}

function validateBadgeForm(formData, file) {
  const errors = {};
  if (!file) {
    errors.baseImage = ["Envie a imagem modelo do cracha."];
  }
  if (!formData.firstCode) {
    errors.firstCode = ["Informe o primeiro codigo numerico."];
  }
  if (!formData.lastCode && !formData.totalBadges) {
    errors.lastCode = ["Informe o ultimo codigo ou a quantidade."];
  }
  if (formData.lastCode && formData.firstCode && formData.lastCode < formData.firstCode) {
    errors.lastCode = ["O ultimo codigo deve ser maior ou igual ao primeiro."];
  }
  if (formData.totalBadges && formData.totalBadges > 1000) {
    errors.totalBadges = ["Gere no maximo 1000 crachas por vez."];
  }
  [
    ["badgeWidthCm", "Largura do cracha"],
    ["badgeHeightCm", "Altura do cracha"],
    ["barcodeWidthCm", "Largura do codigo"],
    ["barcodeHeightCm", "Altura do codigo"],
  ].forEach(([key, label]) => {
    if (!formData[key]) {
      errors[key] = [`${label} deve ser maior que zero.`];
    }
  });
  if (formData.barcodeXCm === null) {
    errors.barcodeXCm = ["X deve ser zero ou maior."];
  }
  if (formData.barcodeYCm === null) {
    errors.barcodeYCm = ["Y deve ser zero ou maior."];
  }
  if (
    formData.badgeWidthCm &&
    formData.badgeHeightCm &&
    formData.barcodeWidthCm &&
    formData.barcodeHeightCm &&
    formData.barcodeXCm !== null &&
    formData.barcodeYCm !== null
  ) {
    if (formData.barcodeXCm + formData.barcodeWidthCm > formData.badgeWidthCm) {
      errors.barcodeXCm = ["O codigo de barras passa da largura do cracha."];
    }
    if (formData.barcodeYCm + formData.barcodeHeightCm > formData.badgeHeightCm) {
      errors.barcodeYCm = ["O codigo de barras passa da altura do cracha."];
    }
  }
  return errors;
}

function buildCodeList({ firstCode, lastCode, totalBadges }) {
  const total = totalBadges || (lastCode - firstCode + 1);
  return Array.from({ length: total }, (_, index) => String(firstCode + index));
}

function countCode39Modules(text) {
  const encoded = `*${text.toUpperCase()}*`;
  return encoded.split("").reduce((total, char, index) => {
    const pattern = CODE39[char];
    if (!pattern) {
      throw new Error(`Codigo "${text}" contem caracteres invalidos para Code39.`);
    }
    const charModules = pattern.split("").reduce((sum, part) => sum + (part === "w" ? 3 : 1), 0);
    return total + charModules + (index === encoded.length - 1 ? 0 : 1);
  }, 0);
}

function drawCode39(doc, text, x, y, width, height) {
  const encoded = `*${text.toUpperCase()}*`;
  const fontSize = Math.min(12, Math.max(8, height * 0.22));
  const labelHeight = fontSize + 4;
  const barHeight = Math.max(8, height - labelHeight);
  const quietZone = Math.min(width * 0.02, 6);
  const narrow = (width - quietZone * 2) / countCode39Modules(text);
  const wide = narrow * 3;
  let cursorX = x + quietZone;

  doc.save();
  doc.rect(x, y, width, height).fill("#ffffff");
  doc.fillColor("#000000");

  encoded.split("").forEach((char, charIndex) => {
    const pattern = CODE39[char];
    pattern.split("").forEach((part, index) => {
      const segmentWidth = part === "w" ? wide : narrow;
      if (index % 2 === 0) {
        doc.rect(cursorX, y, segmentWidth, barHeight).fill("#000000");
      }
      cursorX += segmentWidth;
    });
    if (charIndex !== encoded.length - 1) {
      cursorX += narrow;
    }
  });

  doc
    .font("Helvetica")
    .fontSize(fontSize)
    .fillColor("#000000")
    .text(text, x, y + barHeight + 1, {
      width,
      align: "center",
      lineBreak: false,
    });
  doc.restore();
}

function generateBadgesPdf({ baseImageBuffer, formData }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const pageWidth = cmToPt(formData.badgeWidthCm);
    const pageHeight = cmToPt(formData.badgeHeightCm);
    const codes = buildCodeList(formData);
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
      info: {
        Title: `Crachas ${codes[0]}-${codes[codes.length - 1]}`,
      },
    });

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    codes.forEach((code) => {
      doc.addPage({ size: [pageWidth, pageHeight], margin: 0 });
      doc.image(baseImageBuffer, 0, 0, { width: pageWidth, height: pageHeight });
      drawCode39(
        doc,
        code,
        cmToPt(formData.barcodeXCm),
        cmToPt(formData.barcodeYCm),
        cmToPt(formData.barcodeWidthCm),
        cmToPt(formData.barcodeHeightCm),
      );
    });

    doc.end();
  });
}

module.exports = {
  generateBadgesPdf,
  normalizeBadgeForm,
  validateBadgeForm,
};
