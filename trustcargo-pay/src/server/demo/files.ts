/** Generates small, clearly fictitious demo files (valid PDF / PNG) without bundling binaries. */
import { deflateSync } from 'node:zlib';

function ascii(s: string): string {
    return s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\x20-\x7e]/g, '-')
        .replace(/([()\\])/g, '\\$1');
}

export function makeDemoPdf(title: string, lines: string[]): Uint8Array {
    const content = [
        'BT /F1 16 Tf 50 790 Td (' + ascii(title) + ') Tj ET',
        'BT /F1 11 Tf 50 765 Td (DOCUMENT FICTIF - ENVIRONNEMENT DE DEMONSTRATION - AUCUNE VALEUR JURIDIQUE) Tj ET',
        ...lines.map((l, i) => `BT /F1 11 Tf 50 ${730 - i * 18} Td (${ascii(l)}) Tj ET`)
    ].join('\n');
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((o, i) => {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

/** Simple gradient "photo" placeholder (PNG, 160x100). */
export function makeDemoPng(rgb: [number, number, number]): Uint8Array {
    const w = 160;
    const h = 100;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 3 + 1)] = 0;
        for (let x = 0; x < w; x++) {
            const o = y * (w * 3 + 1) + 1 + x * 3;
            const shade = 0.6 + 0.4 * (y / h);
            raw[o] = Math.round(rgb[0] * shade);
            raw[o + 1] = Math.round(rgb[1] * shade);
            raw[o + 2] = Math.round(rgb[2] * shade);
        }
    }
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ]);
    return new Uint8Array(png);
}
