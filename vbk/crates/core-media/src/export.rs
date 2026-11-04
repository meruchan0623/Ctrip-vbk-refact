use crate::{Canvas, Error, MAX_DIMENSION, MAX_PIXELS};

/// Integer source-pixel crop. Its right/bottom edge is exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Png,
    Jpeg { quality: u8 },
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ExportParams {
    pub crop: Option<PixelRect>,
    pub scale: f64,
    pub format: ExportFormat,
    /// Required for JPEG; RGB background used to flatten source alpha.
    pub background: Option<[u8; 3]>,
}
impl Default for ExportParams {
    fn default() -> Self {
        Self {
            crop: None,
            scale: 1.0,
            format: ExportFormat::Png,
            background: None,
        }
    }
}
/// Validated render/encode request, not encoded bytes or a sendable attachment.
/// Render all annotations in source coordinates, apply the crop, then scale.
/// Never export unannotated source pixels as a fallback for a rendering error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExportPlan {
    pub source: Canvas,
    pub crop: PixelRect,
    pub width: u32,
    pub height: u32,
    pub rgba_bytes: u64,
    pub format: ExportFormat,
    pub background: Option<[u8; 3]>,
}
impl ExportParams {
    pub fn validate(self, canvas: Canvas) -> Result<ExportPlan, Error> {
        let crop = self.crop.unwrap_or(PixelRect {
            x: 0,
            y: 0,
            width: canvas.width(),
            height: canvas.height(),
        });
        if crop.width == 0
            || crop.height == 0
            || crop
                .x
                .checked_add(crop.width)
                .filter(|&x| x <= canvas.width())
                .is_none()
            || crop
                .y
                .checked_add(crop.height)
                .filter(|&y| y <= canvas.height())
                .is_none()
            || !self.scale.is_finite()
            || !(0.01..=8.0).contains(&self.scale)
        {
            return Err(Error::InvalidExport);
        }
        if let ExportFormat::Jpeg { quality } = self.format {
            if !(1..=100).contains(&quality) || self.background.is_none() {
                return Err(Error::InvalidExport);
            }
        }
        let width = (f64::from(crop.width) * self.scale).ceil();
        let height = (f64::from(crop.height) * self.scale).ceil();
        if width < 1.0
            || height < 1.0
            || width > f64::from(MAX_DIMENSION)
            || height > f64::from(MAX_DIMENSION)
        {
            return Err(Error::ResourceLimit);
        }
        let width = width as u32;
        let height = height as u32;
        let pixels = u64::from(width) * u64::from(height);
        if pixels > MAX_PIXELS {
            return Err(Error::ResourceLimit);
        }
        Ok(ExportPlan {
            source: canvas,
            crop,
            width,
            height,
            rgba_bytes: pixels * 4,
            format: self.format,
            background: self.background,
        })
    }
}
