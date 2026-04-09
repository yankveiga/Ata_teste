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

function formatMonthLabel(monthKey) {
  const [year, month] = String(monthKey || "").split("-");
  const monthNumber = Number(month);
  const yearNumber = Number(year);
  const monthsPt = [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
  ];

  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    return monthKey || "";
  }

  if (!Number.isInteger(yearNumber)) {
    return monthKey || "";
  }

  return `${monthsPt[monthNumber - 1]} de ${yearNumber}`;
}

function groupGoalsByProject(goals) {
  const byProject = new Map();
  goals.forEach((goal) => {
    const key = goal.project?.id || -1;
    if (!byProject.has(key)) {
      byProject.set(key, {
        projectName: goal.project?.name || "Projeto não informado",
        goals: [],
      });
    }
    byProject.get(key).goals.push(goal);
  });
  return Array.from(byProject.values()).sort((a, b) =>
    a.projectName.localeCompare(b.projectName, "pt-BR"),
  );
}

function generateMonthlyReportPdf({ member, monthKey, goals, generatedByName = null }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      info: {
        Title: `Relatório Mensal - ${member.name} - ${monthKey}`,
      },
    });

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(18).text("Relatório Mensal de Atividades", {
      align: "left",
    });
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(11);
    doc.text(`Membro: ${member.name}`);
    doc.text(`Mês de referência: ${formatMonthLabel(monthKey)}`);
    doc.text(`Total de metas no mês: ${goals.length}`);
    if (generatedByName) {
      doc.text(`Gerado por: ${generatedByName}`);
    }
    doc.text(`Gerado em: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`);
    doc.moveDown();

    if (!goals.length) {
      doc.font("Helvetica-Oblique").text("Nenhuma meta encontrada para o período selecionado.");
      doc.end();
      return;
    }

    const grouped = groupGoalsByProject(goals);
    grouped.forEach((projectGroup) => {
      if (doc.y > 720) {
        doc.addPage();
      }

      doc
        .font("Helvetica-Bold")
        .fontSize(13)
        .text(projectGroup.projectName, { underline: true });
      doc.moveDown(0.35);

      projectGroup.goals.forEach((goal, index) => {
        const statusLabel = goal.is_completed ? "Concluída" : "Em aberto";
        const weekLabel = goal.week_start || "-";
        doc
          .font("Helvetica-Bold")
          .fontSize(11)
          .text(`${index + 1}. ${goal.activity || "Sem atividade"}`);
        doc
          .font("Helvetica")
          .fontSize(10.5)
          .text(`Status: ${statusLabel} | Semana: ${weekLabel}`);
        if (goal.description && goal.description.trim()) {
          doc.text(`Descrição: ${goal.description.trim()}`);
        } else {
          doc.text("Descrição: (sem descrição)");
        }
        if (goal.completed_at) {
          doc.text(`Concluída em: ${goal.completed_at}`);
        }
        doc.moveDown(0.5);
      });
      doc.moveDown(0.4);
    });

    doc.end();
  });
}

// SECAO: exportacao publica do gerador de PDF para uso nas rotas.

module.exports = {
  generateAtaPdf,
  generateMonthlyReportPdf,
};
