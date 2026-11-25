import qrcode from "qrcode-generator";

export function checkoutQrData(url: string): string {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const pixelsPerModule = 4;
  return qr.createDataURL(pixelsPerModule, 4 * pixelsPerModule);
}
