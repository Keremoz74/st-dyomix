# Writes app-icon.png (1024×1024, the source for `tauri icon`) and the desktop icons in src-tauri/icons
# from the Ozmix Studio logo (brand/ozmix-icon.png, rendered from brand/ozmix-icon.svg by brand/make-logo.py).
from PIL import Image
icon = Image.open('brand/ozmix-icon.png').convert('RGBA').resize((1024, 1024), Image.LANCZOS)
icon.save('app-icon.png')
out = 'src-tauri/icons/'
for name, size in [('32x32.png', 32), ('128x128.png', 128), ('128x128@2x.png', 256), ('icon.png', 512)]:
    icon.resize((size, size), Image.LANCZOS).save(out + name)
icon.save(out + 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
icon.save(out + 'icon.icns')
print('icons written')
