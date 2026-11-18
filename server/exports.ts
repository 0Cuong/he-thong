import fs from 'node:fs';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { GroupResultEntry, RubricCriterionDef } from '../src/lib/domain.ts';

export interface ExportRoomContext {
  classroomName: string;
  roomName: string;
  roomCode: string;
  sessionDate: string;
  scoringMode: string;
  multiGraderPolicy: string;
  maxTotalScore: number;
  criteria: RubricCriterionDef[];
  rankings: GroupResultEntry[];
  groupDetails: Array<{
    groupId: string;
    groupName: string;
    members: Array<{ studentCode: string; fullName: string }>;
    graderAssessments: Array<{
      graderName: string;
      status: string;
      totalScore: number;
      publicFeedback: string;
      overallComment: string;
      strengths: string;
      weaknesses: string;
      suggestions: string;
    }>;
  }>;
}

export async function generateXlsxBuffer(ctx: ExportRoomContext): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lớp 12A17';
  wb.created = new Date();

  const summarySheet = wb.addWorksheet('Bảng Xếp Hạng');
  summarySheet.addRow([`Lớp học: ${ctx.classroomName}`]);
  summarySheet.addRow([`Phòng thuyết trình: ${ctx.roomName} (${ctx.roomCode})`]);
  summarySheet.addRow([`Ngày đánh giá: ${ctx.sessionDate} | Điểm tối đa: ${ctx.maxTotalScore}`]);
  summarySheet.addRow([]);

  const headerRow = [
    'Hạng',
    'Nhóm',
    'Thứ tự TT',
    'Số thành viên',
    'Số giám khảo đã nộp',
    ...ctx.criteria.map((c) => `${c.name} (/${c.maxScore})`),
    `Tổng điểm (/${ctx.maxTotalScore})`,
  ];
  const hdr = summarySheet.addRow(headerRow);
  hdr.font = { bold: true };

  for (const r of ctx.rankings) {
    summarySheet.addRow([
      r.rank ?? 'Chưa chấm',
      r.groupName,
      r.presentationOrder,
      r.memberCount,
      r.submittedGraderCount,
      ...ctx.criteria.map((c) => r.criterionAverages[c.id] ?? '-'),
      r.finalScore ?? '-',
    ]);
  }

  summarySheet.columns.forEach((col) => {
    col.width = 18;
  });

  const detailSheet = wb.addWorksheet('Thành viên & Nhận xét');
  const dHdr = detailSheet.addRow([
    'Nhóm',
    'Thành viên',
    'Giám khảo',
    'Trạng thái phiếu',
    'Điểm giám khảo',
    'Điểm mạnh',
    'Điểm yếu',
    'Góp ý cải thiện',
    'Nhận xét công khai',
  ]);
  dHdr.font = { bold: true };

  for (const gd of ctx.groupDetails) {
    const memberNames = gd.members.map((m) => `${m.studentCode} - ${m.fullName}`).join('; ');
    if (gd.graderAssessments.length === 0) {
      detailSheet.addRow([gd.groupName, memberNames, '-', 'Chưa chấm', '-', '-', '-', '-', '-']);
    } else {
      for (const ga of gd.graderAssessments) {
        detailSheet.addRow([
          gd.groupName,
          memberNames,
          ga.graderName,
          ga.status,
          ga.totalScore,
          ga.strengths,
          ga.weaknesses,
          ga.suggestions,
          ga.publicFeedback || ga.overallComment,
        ]);
      }
    }
  }
  detailSheet.columns.forEach((col) => {
    col.width = 24;
  });

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function escapeCsvCell(value: unknown): string {
  const str = String(value ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function generateCsvString(ctx: ExportRoomContext): string {
  const lines: string[] = [];
  lines.push([`Lớp học`, ctx.classroomName].map(escapeCsvCell).join(','));
  lines.push([`Phòng`, `${ctx.roomName} (${ctx.roomCode})`].map(escapeCsvCell).join(','));
  lines.push([`Ngày đánh giá`, ctx.sessionDate].map(escapeCsvCell).join(','));
  lines.push('');

  const headers = [
    'Hạng',
    'Nhóm',
    'Thành viên',
    'Số giám khảo',
    ...ctx.criteria.map((c) => c.name),
    'Điểm tổng kết',
    'Nhận xét công khai',
  ];
  lines.push(headers.map(escapeCsvCell).join(','));

  const detailMap = new Map(ctx.groupDetails.map((g) => [g.groupId, g]));

  for (const r of ctx.rankings) {
    const detail = detailMap.get(r.groupId);
    const members = detail?.members.map((m) => `${m.studentCode} ${m.fullName}`).join(' | ') ?? '';
    const feedback =
      detail?.graderAssessments
        .map((a) => `${a.graderName}: ${a.publicFeedback || a.overallComment}`)
        .filter((s) => s.trim().length > 0)
        .join(' / ') ?? '';

    const row = [
      r.rank ?? '-',
      r.groupName,
      members,
      r.submittedGraderCount,
      ...ctx.criteria.map((c) => r.criterionAverages[c.id] ?? '-'),
      r.finalScore ?? '-',
      feedback,
    ];
    lines.push(row.map(escapeCsvCell).join(','));
  }

  return '\uFEFF' + lines.join('\r\n');
}

const FONT_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

export function generatePdfBuffer(ctx: ExportRoomContext): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const hasRegularFont = fs.existsSync(FONT_REGULAR);
    const hasBoldFont = fs.existsSync(FONT_BOLD);
    if (hasRegularFont) {
      doc.registerFont('VN-Regular', FONT_REGULAR);
      doc.font('VN-Regular');
    }
    if (hasBoldFont) {
      doc.registerFont('VN-Bold', FONT_BOLD);
    }

    const useBold = () => doc.font(hasBoldFont ? 'VN-Bold' : 'Helvetica-Bold');
    const useRegular = () => doc.font(hasRegularFont ? 'VN-Regular' : 'Helvetica');

    useBold().fontSize(16).text('BÁO CÁO KẾT QUẢ THUYẾT TRÌNH — LỚP 12A17', { align: 'left' });
    doc.moveDown(0.3);
    useRegular()
      .fontSize(10)
      .fillColor('#334155')
      .text(`Lớp học: ${ctx.classroomName}`)
      .text(`Phòng: ${ctx.roomName} (${ctx.roomCode})   |   Ngày: ${ctx.sessionDate}`)
      .text(`Chính sách tính điểm: ${ctx.multiGraderPolicy === 'WEIGHTED_AVERAGE' ? 'Trung bình có trọng số' : 'Trung bình cộng'}   |   Thang điểm tối đa: ${ctx.maxTotalScore}`);

    doc.moveDown(0.8);
    useBold().fontSize(12).fillColor('#0f172a').text('1. Bảng xếp hạng tổng hợp');
    doc.moveDown(0.4);

    for (const r of ctx.rankings) {
      useBold()
        .fontSize(10)
        .fillColor('#0f172a')
        .text(
          `${r.rank ? `Hạng ${r.rank}${r.isTied ? ' (Đồng hạng)' : ''}` : 'Chưa có điểm'} — ${r.groupName}: ${
            r.finalScore !== null ? `${r.finalScore} / ${ctx.maxTotalScore}` : 'Chưa chấm'
          } (${r.memberCount} thành viên, ${r.submittedGraderCount} phiếu chấm)`
        );
      const critLine = ctx.criteria
        .map((c) => `${c.name}: ${r.criterionAverages[c.id] ?? '-'}/${c.maxScore}`)
        .join('  ·  ');
      useRegular().fontSize(8.5).fillColor('#475569').text(critLine);
      doc.moveDown(0.35);
    }

    doc.moveDown(0.6);
    useBold().fontSize(12).fillColor('#0f172a').text('2. Danh sách thành viên & Nhận xét công khai');
    doc.moveDown(0.4);

    for (const gd of ctx.groupDetails) {
      useBold().fontSize(10).fillColor('#1e293b').text(gd.groupName);
      const membersStr =
        gd.members.length > 0
          ? gd.members.map((m) => `${m.studentCode} (${m.fullName})`).join(', ')
          : 'Chưa có thành viên';
      useRegular().fontSize(8.5).fillColor('#475569').text(`Thành viên: ${membersStr}`);

      if (gd.graderAssessments.length === 0) {
        useRegular().fontSize(8.5).fillColor('#64748b').text('Chưa có phiếu chấm được nộp.');
      } else {
        for (const ga of gd.graderAssessments) {
          useRegular()
            .fontSize(8.5)
            .fillColor('#0f172a')
            .text(
              `- ${ga.graderName} (${ga.totalScore}đ): ${ga.publicFeedback || ga.overallComment || 'Không có nhận xét'}`
            );
        }
      }
      doc.moveDown(0.4);
    }

    doc.end();
  });
}
