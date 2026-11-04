use crate::{Canvas, Error};

pub const MAX_ANNOTATIONS: usize = 512;
pub const MAX_HISTORY: usize = 256;
pub const MAX_TEXT_BYTES: usize = 4096;
pub const MAX_DOCUMENT_TEXT_BYTES: usize = 256 * 1024;
pub const MAX_PATH_POINTS: usize = 4096;
pub const MAX_DOCUMENT_POINTS: usize = 32 * 1024;
pub const MAX_RETAINED_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    pub fn validate(self, canvas: Canvas) -> Result<(), Error> {
        if !self.width.is_finite()
            || !self.height.is_finite()
            || self.width <= 0.0
            || self.height <= 0.0
            || !canvas.contains(Point {
                x: self.x,
                y: self.y,
            })
            || !canvas.contains(Point {
                x: self.x + self.width,
                y: self.y + self.height,
            })
        {
            return Err(Error::InvalidGeometry);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgba {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
    pub alpha: u8,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stroke {
    pub color: Rgba,
    pub width: f64,
}
impl Stroke {
    fn validate(self) -> Result<(), Error> {
        if !self.width.is_finite() || !(0.5..=128.0).contains(&self.width) || self.color.alpha == 0
        {
            return Err(Error::InvalidStyle);
        }
        Ok(())
    }
}

/// Geometry uses source-image pixels. All geometric tools have centered
/// strokes with round caps/joins; text is clipped to `bounds`. Mosaic block size is in source pixels,
/// with the grid anchored at the region's top-left corner (no opacity option).
#[derive(Debug, Clone, PartialEq)]
pub enum Annotation {
    Rectangle {
        bounds: Rect,
        stroke: Stroke,
    },
    Ellipse {
        bounds: Rect,
        stroke: Stroke,
    },
    /// A polyline with round caps and joins. One point is a round brush dot.
    Pen {
        points: Vec<Point>,
        stroke: Stroke,
    },
    Arrow {
        from: Point,
        to: Point,
        head_length: f64,
        stroke: Stroke,
    },
    Text {
        bounds: Rect,
        text: String,
        font_size: f64,
        color: Rgba,
    },
    Mosaic {
        bounds: Rect,
        block_size: u16,
    },
}
impl Annotation {
    pub fn validate(&self, canvas: Canvas) -> Result<(), Error> {
        let inside_stroke = |point: Point, width: f64| {
            let half = width / 2.0;
            canvas.contains(Point {
                x: point.x - half,
                y: point.y - half,
            }) && canvas.contains(Point {
                x: point.x + half,
                y: point.y + half,
            })
        };
        match self {
            Self::Rectangle { bounds, stroke } | Self::Ellipse { bounds, stroke } => {
                bounds.validate(canvas)?;
                stroke.validate()?;
                if !inside_stroke(
                    Point {
                        x: bounds.x,
                        y: bounds.y,
                    },
                    stroke.width,
                ) || !inside_stroke(
                    Point {
                        x: bounds.x + bounds.width,
                        y: bounds.y + bounds.height,
                    },
                    stroke.width,
                ) {
                    return Err(Error::InvalidGeometry);
                }
            }
            Self::Pen { points, stroke } => {
                stroke.validate()?;
                if points.is_empty() || points.len() > MAX_PATH_POINTS {
                    return Err(Error::ResourceLimit);
                }
                // A round-capped/joined polyline is contained by the union
                // of these point discs and the connecting segment capsules.
                if points.iter().any(|p| !inside_stroke(*p, stroke.width)) {
                    return Err(Error::InvalidGeometry);
                }
            }
            Self::Arrow {
                from,
                to,
                head_length,
                stroke,
            } => {
                stroke.validate()?;
                if !canvas.contains(*from) || !canvas.contains(*to) {
                    return Err(Error::InvalidGeometry);
                }
                let dx = to.x - from.x;
                let dy = to.y - from.y;
                let length = dx.hypot(dy);
                if !head_length.is_finite() || *head_length < 1.0 || *head_length > length {
                    return Err(Error::InvalidGeometry);
                }
                // Arrowhead triangle: tip at `to`, base width = head_length.
                let ux = dx / length;
                let uy = dy / length;
                let base = Point {
                    x: to.x - ux * head_length,
                    y: to.y - uy * head_length,
                };
                for p in [
                    *from,
                    *to,
                    Point {
                        x: base.x + uy * head_length / 2.0,
                        y: base.y - ux * head_length / 2.0,
                    },
                    Point {
                        x: base.x - uy * head_length / 2.0,
                        y: base.y + ux * head_length / 2.0,
                    },
                ] {
                    if !inside_stroke(p, stroke.width) {
                        return Err(Error::InvalidGeometry);
                    }
                }
            }
            Self::Text {
                bounds,
                text,
                font_size,
                color,
            } => {
                bounds.validate(canvas)?;
                if text.is_empty()
                    || text.trim().is_empty()
                    || text.len() > MAX_TEXT_BYTES
                    || text
                        .chars()
                        .any(|c| c.is_control() && c != '\n' && c != '\t')
                {
                    return Err(Error::InvalidText);
                }
                if !font_size.is_finite() || !(4.0..=512.0).contains(font_size) || color.alpha == 0
                {
                    return Err(Error::InvalidStyle);
                }
            }
            Self::Mosaic { bounds, block_size } => {
                bounds.validate(canvas)?;
                if !(2..=128).contains(block_size) {
                    return Err(Error::InvalidStyle);
                }
            }
        }
        Ok(())
    }
    fn point_count(&self) -> usize {
        match self {
            Self::Pen { points, .. } => points.len(),
            _ => 0,
        }
    }
    fn heap_bytes(&self) -> usize {
        self.text_bytes() + self.point_count() * std::mem::size_of::<Point>()
    }
    fn text_bytes(&self) -> usize {
        match self {
            Self::Text { text, .. } => text.len(),
            _ => 0,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct AnnotationId(u64);
impl AnnotationId {
    pub fn value(self) -> u64 {
        self.0
    }
}
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: AnnotationId,
    pub annotation: Annotation,
}
#[derive(Debug, Clone)]
struct Edit {
    index: usize,
    before: Option<Entry>,
    after: Option<Entry>,
}
impl Edit {
    fn bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self
                .before
                .as_ref()
                .map_or(0, |e| e.annotation.heap_bytes())
            + self.after.as_ref().map_or(0, |e| e.annotation.heap_bytes())
    }
}
/// Transactional bounded edit history; failed edits leave document and redo
/// branch intact. Successful edits after undo discard only the redo branch.
#[derive(Debug, Clone)]
pub struct Document {
    canvas: Canvas,
    entries: Vec<Entry>,
    history: Vec<Edit>,
    cursor: usize,
    next_id: u64,
}
impl Document {
    pub fn new(canvas: Canvas) -> Self {
        Self {
            canvas,
            entries: vec![],
            history: vec![],
            cursor: 0,
            next_id: 1,
        }
    }
    pub fn canvas(&self) -> Canvas {
        self.canvas
    }
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }
    pub fn can_undo(&self) -> bool {
        self.cursor > 0
    }
    pub fn can_redo(&self) -> bool {
        self.cursor < self.history.len()
    }
    pub fn add(&mut self, annotation: Annotation) -> Result<AnnotationId, Error> {
        if self.entries.len() >= MAX_ANNOTATIONS {
            return Err(Error::ResourceLimit);
        }
        let next = self.next_id.checked_add(1).ok_or(Error::ResourceLimit)?;
        let id = AnnotationId(self.next_id);
        self.commit(Edit {
            index: self.entries.len(),
            before: None,
            after: Some(Entry { id, annotation }),
        })?;
        self.next_id = next;
        Ok(id)
    }
    pub fn replace(&mut self, id: AnnotationId, annotation: Annotation) -> Result<(), Error> {
        let index = self.index(id)?;
        self.commit(Edit {
            index,
            before: Some(self.entries[index].clone()),
            after: Some(Entry { id, annotation }),
        })
    }
    pub fn remove(&mut self, id: AnnotationId) -> Result<(), Error> {
        let index = self.index(id)?;
        self.commit(Edit {
            index,
            before: Some(self.entries[index].clone()),
            after: None,
        })
    }
    fn index(&self, id: AnnotationId) -> Result<usize, Error> {
        self.entries
            .iter()
            .position(|e| e.id == id)
            .ok_or(Error::NotFound)
    }
    fn commit(&mut self, mut edit: Edit) -> Result<(), Error> {
        if let Some(entry) = &edit.after {
            entry.annotation.validate(self.canvas)?;
        }
        // Caller-owned spare String/Vec capacity is never retained.
        if let Some(entry) = &mut edit.after {
            match &mut entry.annotation {
                Annotation::Text { text, .. } => {
                    *text = std::mem::take(text).into_boxed_str().into_string();
                }
                Annotation::Pen { points, .. } => {
                    *points = std::mem::take(points).into_boxed_slice().into_vec();
                }
                _ => {}
            }
        }
        let points = self
            .entries
            .iter()
            .map(|e| e.annotation.point_count())
            .sum::<usize>()
            - edit
                .before
                .as_ref()
                .map_or(0, |e| e.annotation.point_count())
            + edit
                .after
                .as_ref()
                .map_or(0, |e| e.annotation.point_count());
        let text = self
            .entries
            .iter()
            .map(|e| e.annotation.text_bytes())
            .sum::<usize>()
            - edit
                .before
                .as_ref()
                .map_or(0, |e| e.annotation.text_bytes())
            + edit.after.as_ref().map_or(0, |e| e.annotation.text_bytes());
        let skip = usize::from(self.cursor == MAX_HISTORY);
        let retained = self.history[skip..self.cursor]
            .iter()
            .map(Edit::bytes)
            .sum::<usize>()
            + edit.bytes()
            // Reserve the largest possible document as undo can restore a
            // larger text/path state without admitting another edit.
            + MAX_DOCUMENT_TEXT_BYTES
            + MAX_DOCUMENT_POINTS * std::mem::size_of::<Point>()
            + MAX_ANNOTATIONS * std::mem::size_of::<Entry>();
        if text > MAX_DOCUMENT_TEXT_BYTES
            || points > MAX_DOCUMENT_POINTS
            || retained > MAX_RETAINED_BYTES
        {
            return Err(Error::ResourceLimit);
        }
        self.history.truncate(self.cursor);
        if skip != 0 {
            self.history.remove(0);
        }
        Self::apply(&mut self.entries, &edit, true);
        self.history.push(edit);
        self.cursor = self.history.len();
        Ok(())
    }
    fn apply(entries: &mut Vec<Entry>, edit: &Edit, forward: bool) {
        let (before, after) = if forward {
            (&edit.before, &edit.after)
        } else {
            (&edit.after, &edit.before)
        };
        match (before, after) {
            (None, Some(entry)) => entries.insert(edit.index, entry.clone()),
            (Some(_), None) => {
                entries.remove(edit.index);
            }
            (Some(_), Some(entry)) => entries[edit.index] = entry.clone(),
            (None, None) => unreachable!("edits always change an entry"),
        }
    }
    pub fn undo(&mut self) -> bool {
        if !self.can_undo() {
            return false;
        }
        self.cursor -= 1;
        Self::apply(&mut self.entries, &self.history[self.cursor], false);
        true
    }
    pub fn redo(&mut self) -> bool {
        if !self.can_redo() {
            return false;
        }
        Self::apply(&mut self.entries, &self.history[self.cursor], true);
        self.cursor += 1;
        true
    }
}
