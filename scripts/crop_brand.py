from PIL import Image
import os

logo_path = 'C:/Users/karth/.gemini/antigravity-ide/brain/3dba00e3-1684-4452-947d-ac0a7d18e9cd/.user_uploaded/media_1791141129544.png'
fav_path = 'C:/Users/karth/.gemini/antigravity-ide/brain/3dba00e3-1684-4452-947d-ac0a7d18e9cd/.user_uploaded/media_1791141177951.png'

out_dir = 'client/public'
os.makedirs(out_dir, exist_ok=True)

# 1. Process Logo
logo = Image.open(logo_path).convert('RGBA')
bbox = logo.getbbox()
# Add a 6px margin
margin_x = 6
margin_y = 6
crop_box = (
    max(0, bbox[0] - margin_x),
    max(0, bbox[1] - margin_y),
    min(logo.width, bbox[2] + margin_x),
    min(logo.height, bbox[3] + margin_y)
)
cropped_logo = logo.crop(crop_box)
cropped_logo.save(os.path.join(out_dir, 'logo.png'), 'PNG')
print("Successfully generated client/public/logo.png, size:", cropped_logo.size)

# Create Dark/Inverted Version (turn black text into white, keep blue pixels)
dark_logo = cropped_logo.copy()
pixels = dark_logo.load()
for y in range(dark_logo.height):
    for x in range(dark_logo.width):
        r, g, b, a = pixels[x, y]
        if a > 10:
            # Check if it's blue (high blue, lower red/green)
            is_blue = b > 140 and r < 80 and g < 140
            if not is_blue:
                # It's the black/dark text: convert to white with preserved alpha
                pixels[x, y] = (255, 255, 255, a)

dark_logo.save(os.path.join(out_dir, 'logo-dark.png'), 'PNG')
print("Successfully generated client/public/logo-dark.png, size:", dark_logo.size)

# 2. Process Favicon
fav = Image.open(fav_path).convert('RGBA')
fav_bbox = fav.getbbox()
# Add margin to keep it square
fav_size = max(fav_bbox[2] - fav_bbox[0], fav_bbox[3] - fav_bbox[1]) + 16
center_x = (fav_bbox[0] + fav_bbox[2]) // 2
center_y = (fav_bbox[1] + fav_bbox[3]) // 2
half = fav_size // 2

fav_crop_box = (
    center_x - half,
    center_y - half,
    center_x + half,
    center_y + half
)
cropped_fav = fav.crop(fav_crop_box)
cropped_fav.save(os.path.join(out_dir, 'favicon.png'), 'PNG')

# Generate .ico with multiple sizes (16, 32, 48, 64)
cropped_fav.save(os.path.join(out_dir, 'favicon.ico'), format='ICO', sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
print("Successfully generated client/public/favicon.png and favicon.ico, size:", cropped_fav.size)
