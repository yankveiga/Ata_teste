/*
 * ARQUIVO: src/pdf.js
 * FUNCAO: gera o PDF de atas (cabecalho, texto e layout final com PDFKit).
 * IMPACTO DE MUDANCAS:
 * - Ajustes de layout podem cortar conteudo, quebrar paginacao ou desalinhamento visual no documento final.
 * - Mudancas em campos exibidos devem manter consistencia com dados persistidos em banco.
 */
const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");

const { config } = require("./config");
const { extractDateParts, formatDateExtenso } = require("./utils");

// SECAO: composicao visual do cabecalho institucional do PDF de ata.

function drawHeader(doc, ata) {
  const logoPath = path.join(config.uploadDir, "FURG.png");
  const topY = 35;

  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, doc.page.width / 2 - 25, topY, {
      fit: [50, 50],
      align: "center",
    });
  }

  doc
    .font("Helvetica")
    .fontSize(10)
    .text("UNIVERSIDADE FEDERAL DO RIO GRANDE – FURG", 72, 95, {
      align: "center",
    })
    .text("CENTRO DE CIÊNCIAS COMPUTACIONAIS", {
      align: "center",
    })
    .text("PET – Ciências Computacionais – C3", {
      align: "center",
    })
    .moveDown(0.25)
    .font("Helvetica-Bold")
    .text(`ATA ${formatDateForTitle(ata.meeting_datetime)}`, {
      align: "center",
    });

  doc.moveDown(2);
}

// SECAO: utilitarios de texto para titulo e descricoes de presenca/ausencia.

function formatDateForTitle(value) {
  const parts = extractDateParts(value);
  if (!parts) {
    return "";
  }
  return `${String(parts.day).padStart(2, "0")}/${String(parts.month).padStart(2, "0")}/${parts.year}`;
}

function buildPresentText(members) {
  const names = members.map((member) => member.name).sort((a, b) => a.localeCompare(b));

  if (names.length === 0) {
    return "sem a presença de integrantes registrados";
  }

  if (names.length === 1) {
    return `com o seguinte presente: ${names[0]}`;
  }

  return `com os seguintes presentes: ${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

function buildAbsentText(ata) {
  const withJustification = [];
  const withoutJustification = [];

  ata.absent_members.forEach((member) => {
    const justification = ata.absent_justifications_dict[member.id];
    if (justification && justification.trim()) {
      withJustification.push(`${member.name} (Motivo: ${justification.trim()})`);
    } else {
      withoutJustification.push(member.name);
    }
  });

  let text = "";

  if (withJustification.length > 0) {
    text += `Estiveram ausentes com justificativa: ${withJustification.join(", ")}. `;
  }

  if (withoutJustification.length === 1) {
    text += `Estiveram ausentes sem justificativa: ${withoutJustification[0]}.`;
  } else if (withoutJustification.length > 1) {
    text += `Estiveram ausentes sem justificativa: ${withoutJustification
      .slice(0, -1)
      .join(", ")} e ${withoutJustification[withoutJustification.length - 1]}.`;
  }

  return text.trim() || "Nenhum membro ausente.";
}

// SECAO: montagem completa do documento PDF (layout, conteudo e stream de saida).

function generateAtaPdf(ata) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: "A4",
      margins: {
        top: 140,
        bottom: 56,
        left: 85,
        right: 56,
      },
      info: {
        Title: `Ata Reunião PET Ciências Computacionais - ${ata.project.name}`,
      },
    });

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawHeader(doc, ata);

    const intro = `Aos ${formatDateExtenso(ata.meeting_datetime)}, reuniram-se os integrantes do PET Ciências Computacionais ${buildPresentText(ata.present_members)}. ${buildAbsentText(ata)}`;

    doc
      .font("Times-Roman")
      .fontSize(12)
      .text(intro, {
        align: "justify",
        indent: 35,
        lineGap: 6,
      })
      .moveDown();

    if (ata.notes && ata.notes.trim()) {
      ata.notes
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          doc.text(line, {
            align: "justify",
            indent: 35,
            lineGap: 6,
          });
        });
    } else {
      doc.text("Nenhuma anotação registrada.", {
        align: "justify",
        indent: 35,
        lineGap: 6,
      });
    }

    doc.moveDown();
    doc.text(
      `Posteriormente, foi lavrada a presente ata, que será lida e aprovada em próxima reunião. Rio Grande, aos ${formatDateExtenso(ata.meeting_datetime)}.`,
      {
        align: "justify",
        indent: 35,
        lineGap: 6,
      },
    );

    doc.end();
  });
}

// SECAO: exportacao publica do gerador de PDF para uso nas rotas.

module.exports = { generateAtaPdf };
