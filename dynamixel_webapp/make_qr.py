# save as make_qr.py
import sys
import qrcode

def main():
    if len(sys.argv) < 2:
        print("Usage: python make_qr.py <link> [output.png]")
        raise SystemExit(1)

    link = sys.argv[1]
    out_file = sys.argv[2] if len(sys.argv) >= 3 else "qr.png"

    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=4,
    )
    qr.add_data(link)
    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white")
    img.save(out_file)
    print(f"Saved QR code to: {out_file}")

if __name__ == "__main__":
    main()
