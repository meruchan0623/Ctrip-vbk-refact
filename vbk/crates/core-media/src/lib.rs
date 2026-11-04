//! Platform-independent screenshot annotation state. No capture, image bytes,
//! networking, filesystem, customer identity or send capability lives here.
//! A renderer must clip text to its explicit box and apply every mosaic to
//! source pixels before encoding. This model alone does not redact an image.

mod annotation;
mod export;
pub use annotation::*;
pub use export::*;

pub const MAX_DIMENSION: u32 = 16_384;
pub const MAX_PIXELS: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidCanvas,
    InvalidGeometry,
    InvalidStyle,
    InvalidText,
    InvalidExport,
    NotFound,
    ResourceLimit,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Canvas {
    width: u32,
    height: u32,
}
impl Canvas {
    pub fn new(width: u32, height: u32) -> Result<Self, Error> {
        if width == 0
            || height == 0
            || width > MAX_DIMENSION
            || height > MAX_DIMENSION
            || u64::from(width) * u64::from(height) > MAX_PIXELS
        {
            return Err(Error::InvalidCanvas);
        }
        Ok(Self { width, height })
    }
    pub fn width(self) -> u32 {
        self.width
    }
    pub fn height(self) -> u32 {
        self.height
    }
    pub(crate) fn contains(self, point: Point) -> bool {
        point.x.is_finite()
            && point.y.is_finite()
            && point.x >= 0.0
            && point.y >= 0.0
            && point.x <= f64::from(self.width)
            && point.y <= f64::from(self.height)
    }
}
