// Préparation d'une photo avant l'envoi, sur le téléphone : orientation corrigée, taille réduite et
// réencodage en JPEG. Le réencodage par un canevas ne recopie AUCUNE métadonnée (EXIF, position GPS,
// modèle de l'appareil) : seule l'image part.

export const MAX_IMAGE_DIMENSION = 2000;
const JPEG_QUALITY = 0.82;

export class UnsupportedImageError extends Error {
    override readonly name = 'UnsupportedImageError';
}

export async function prepareImage(file: Blob): Promise<Blob> {
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
        throw new UnsupportedImageError('image could not be decoded');
    }
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new UnsupportedImageError('canvas unavailable');
    context.fillStyle = '#ffffff'; // fond blanc pour les PNG transparents
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) throw new UnsupportedImageError('encoding failed');
    return blob;
}
