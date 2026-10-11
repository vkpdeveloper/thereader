"""Regenerate original bit-pattern fixtures using an independent TIFF encoder."""
from PIL import Image
from io import BytesIO
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
for width in [17,513]:
    im=Image.new('1',(width,16),0)
    for y in range(16):
        for x in range(width):
            bit=y==1 or (y>1 and ((x//(y*3+1)+y)%4 in (0,1)))
            im.putpixel((x,y),255 if bit else 0)
    for compression in ['group3','group4']:
        b=BytesIO();im.save(b,format='TIFF',compression=compression)
        raw=b.getvalue();t=Image.open(BytesIO(raw))
        offset=t.tag_v2[273][0];size=t.tag_v2[279][0]
        # Retain only the fax strip. TIFF's Photometric tag is unrelated to
        # decodeFax's convention: 1 denotes a coded black run.
        (ROOT/f'packages/pdf_go/testdata/fax/{compression}-{width}.bin').write_bytes(raw[offset:offset+size])
