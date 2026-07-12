import ExcelJS from 'exceljs';

export function sendExcel(res, { buffer, filename }) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}

export async function workbookBuffer(workbook) {
  return workbook.xlsx.writeBuffer();
}

export function styleHeaderRow(sheet, rowNumber = 1) {
  const row = sheet.getRow(rowNumber);
  row.font = { bold: true };
  row.alignment = { vertical: 'middle' };
}

export function addSheetFromRows(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns;
  for (const row of rows) sheet.addRow(row);
  styleHeaderRow(sheet);
  return sheet;
}

export default { sendExcel, workbookBuffer, styleHeaderRow, addSheetFromRows };
