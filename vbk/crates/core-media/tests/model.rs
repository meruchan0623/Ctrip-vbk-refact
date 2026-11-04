use core_media::*;
fn canvas() -> Canvas {
    Canvas::new(1000, 800).unwrap()
}
fn bounds() -> Rect {
    Rect {
        x: 20.0,
        y: 20.0,
        width: 200.0,
        height: 100.0,
    }
}
fn color() -> Rgba {
    Rgba {
        red: 255,
        green: 0,
        blue: 0,
        alpha: 255,
    }
}
fn stroke() -> Stroke {
    Stroke {
        color: color(),
        width: 2.0,
    }
}
fn text(value: &str) -> Annotation {
    Annotation::Text {
        bounds: bounds(),
        text: value.into(),
        font_size: 16.0,
        color: color(),
    }
}
fn mosaic() -> Annotation {
    Annotation::Mosaic {
        bounds: bounds(),
        block_size: 10,
    }
}
fn tools() -> Vec<Annotation> {
    vec![
        Annotation::Rectangle {
            bounds: bounds(),
            stroke: stroke(),
        },
        Annotation::Arrow {
            from: Point { x: 50.0, y: 50.0 },
            to: Point { x: 200.0, y: 200.0 },
            head_length: 20.0,
            stroke: stroke(),
        },
        text("本地文字\n第二行"),
        mosaic(),
        Annotation::Ellipse {
            bounds: bounds(),
            stroke: stroke(),
        },
        pen(3),
    ]
}
#[test]
fn every_tool_round_trips_undo_redo_and_preserves_order_and_ids() {
    let mut document = Document::new(canvas());
    for tool in tools() {
        document.add(tool).unwrap();
    }
    let expected = document.entries().to_vec();
    for _ in 0..expected.len() {
        assert!(document.undo());
    }
    assert!(document.entries().is_empty());
    assert!(!document.undo());
    for _ in 0..expected.len() {
        assert!(document.redo());
    }
    assert_eq!(document.entries(), expected);
    assert!(!document.redo());
    let id = expected[1].id;
    document.replace(id, text("changed")).unwrap();
    assert_eq!(document.entries()[1].id, id);
    document.remove(id).unwrap();
    assert_eq!(document.entries().len(), expected.len() - 1);
    document.undo();
    assert_eq!(document.entries()[1].annotation, text("changed"));
    document.undo();
    assert_eq!(document.entries(), expected);
    document.redo();
    document.redo();
    assert_eq!(document.entries().len(), expected.len() - 1);
}
#[test]
fn new_branch_discards_redo_but_failed_edit_does_not() {
    let mut d = Document::new(canvas());
    let a = d.add(mosaic()).unwrap();
    let b = d.add(text("b")).unwrap();
    d.undo();
    assert_eq!(d.add(text("\0")), Err(Error::InvalidText));
    assert!(d.can_redo());
    let c = d.add(text("c")).unwrap();
    assert!(c.value() > b.value());
    assert!(!d.can_redo());
    assert_eq!(d.remove(b), Err(Error::NotFound));
    assert_eq!(d.entries()[0].id, a);
}
#[test]
fn rejects_nonfinite_negative_zero_and_outside_geometry_without_mutating() {
    for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0] {
        let mut d = Document::new(canvas());
        assert_eq!(
            d.add(Annotation::Mosaic {
                bounds: Rect {
                    x: invalid,
                    ..bounds()
                },
                block_size: 10
            }),
            Err(Error::InvalidGeometry)
        );
        assert!(d.entries().is_empty());
        assert!(!d.can_undo());
    }
    for width in [0.0, -1.0, f64::NAN, f64::INFINITY, 1001.0] {
        assert!(Annotation::Mosaic {
            bounds: Rect { width, ..bounds() },
            block_size: 10
        }
        .validate(canvas())
        .is_err());
    }
    assert!(Canvas::new(0, 1).is_err());
    assert!(Canvas::new(u32::MAX, 1).is_err());
    assert!(Canvas::new(16384, 16384).is_err());
    assert!(Annotation::Rectangle {
        bounds: Rect { x: 0.0, ..bounds() },
        stroke: stroke()
    }
    .validate(canvas())
    .is_err());
    assert!(Annotation::Arrow {
        from: Point { x: 20.0, y: 20.0 },
        to: Point { x: 20.0, y: 20.0 },
        head_length: 1.0,
        stroke: stroke()
    }
    .validate(canvas())
    .is_err());
    // Endpoints alone are inside, but the arrow head crosses the upper edge.
    assert!(Annotation::Arrow {
        from: Point { x: 20.0, y: 2.0 },
        to: Point { x: 200.0, y: 2.0 },
        head_length: 20.0,
        stroke: stroke()
    }
    .validate(canvas())
    .is_err());
}
#[test]
fn styles_text_and_mosaic_have_explicit_limits() {
    for width in [0.0, -1.0, f64::NAN, f64::INFINITY, 129.0] {
        assert!(Annotation::Rectangle {
            bounds: bounds(),
            stroke: Stroke { width, ..stroke() }
        }
        .validate(canvas())
        .is_err());
    }
    for value in ["", "   ", "\0", "bad\u{001b}"] {
        assert_eq!(text(value).validate(canvas()), Err(Error::InvalidText));
    }
    assert_eq!(
        text(&"中".repeat(MAX_TEXT_BYTES / 3 + 1)).validate(canvas()),
        Err(Error::InvalidText)
    );
    for block_size in [0, 1, 129, u16::MAX] {
        assert_eq!(
            Annotation::Mosaic {
                bounds: bounds(),
                block_size
            }
            .validate(canvas()),
            Err(Error::InvalidStyle)
        );
    }
    assert_eq!(
        Annotation::Text {
            bounds: bounds(),
            text: "x".into(),
            font_size: f64::NAN,
            color: color()
        }
        .validate(canvas()),
        Err(Error::InvalidStyle)
    );
}
#[test]
fn annotation_text_and_history_resource_limits_are_enforced() {
    let mut d = Document::new(canvas());
    for _ in 0..MAX_ANNOTATIONS {
        d.add(mosaic()).unwrap();
    }
    assert_eq!(d.add(mosaic()), Err(Error::ResourceLimit));
    let mut undos = 0;
    while d.undo() {
        undos += 1;
    }
    assert_eq!(undos, MAX_HISTORY);
    assert_eq!(d.entries().len(), MAX_ANNOTATIONS - MAX_HISTORY);
    let mut d = Document::new(canvas());
    let full_text = "a".repeat(MAX_TEXT_BYTES);
    for _ in 0..MAX_DOCUMENT_TEXT_BYTES / MAX_TEXT_BYTES {
        d.add(text(&full_text)).unwrap();
    }
    assert_eq!(d.add(text("x")), Err(Error::ResourceLimit));
    // Replacing one item repeatedly also bounds retained undo data.
    let id = d.entries()[0].id;
    for i in 0..1000 {
        let next = if i % 2 == 0 {
            "b".repeat(MAX_TEXT_BYTES)
        } else {
            full_text.clone()
        };
        if d.replace(id, text(&next)) == Err(Error::ResourceLimit) {
            return;
        }
    }
    panic!("history payload cap was never enforced");
}
#[test]
fn exports_validate_crop_scaling_formats_and_pixel_budget() {
    let plan = ExportParams::default().validate(canvas()).unwrap();
    assert_eq!(
        (plan.width, plan.height, plan.rgba_bytes),
        (1000, 800, 3_200_000)
    );
    let crop = PixelRect {
        x: 10,
        y: 20,
        width: 101,
        height: 51,
    };
    let plan = ExportParams {
        crop: Some(crop),
        scale: 1.5,
        ..ExportParams::default()
    }
    .validate(canvas())
    .unwrap();
    assert_eq!((plan.width, plan.height), (152, 77));
    for scale in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -1.0, 9.0] {
        assert_eq!(
            ExportParams {
                scale,
                ..ExportParams::default()
            }
            .validate(canvas()),
            Err(Error::InvalidExport)
        );
    }
    for crop in [
        PixelRect {
            x: u32::MAX,
            y: 0,
            width: 2,
            height: 1,
        },
        PixelRect {
            x: 999,
            y: 0,
            width: 2,
            height: 1,
        },
        PixelRect {
            x: 0,
            y: 0,
            width: 0,
            height: 1,
        },
    ] {
        assert_eq!(
            ExportParams {
                crop: Some(crop),
                ..ExportParams::default()
            }
            .validate(canvas()),
            Err(Error::InvalidExport)
        );
    }
    for quality in [0, 101, 255] {
        assert_eq!(
            ExportParams {
                format: ExportFormat::Jpeg { quality },
                background: Some([255; 3]),
                ..ExportParams::default()
            }
            .validate(canvas()),
            Err(Error::InvalidExport)
        );
    }
    assert!(ExportParams {
        format: ExportFormat::Jpeg { quality: 90 },
        ..ExportParams::default()
    }
    .validate(canvas())
    .is_err());
    assert!(ExportParams {
        format: ExportFormat::Jpeg { quality: 90 },
        background: Some([255; 3]),
        ..ExportParams::default()
    }
    .validate(canvas())
    .is_ok());
    assert_eq!(
        ExportParams {
            scale: 8.0,
            ..ExportParams::default()
        }
        .validate(Canvas::new(4096, 4096).unwrap()),
        Err(Error::ResourceLimit)
    );
    assert_eq!(
        ExportParams {
            scale: 2.0,
            ..ExportParams::default()
        }
        .validate(Canvas::new(8192, 4096).unwrap()),
        Err(Error::ResourceLimit)
    );
}

#[test]
fn mixed_edits_match_a_snapshot_oracle_through_undo_and_new_branches() {
    let mut d = Document::new(canvas());
    let mut states: Vec<Vec<Entry>> = vec![vec![]];
    let mut cursor = 0usize;
    let mut seed = 42u64;
    for i in 0..200 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let mut expected = states[cursor].clone();
        let changed = match (seed >> 32) % 5 {
            0 if !expected.is_empty() => {
                let index = (seed as usize) % expected.len();
                let id = expected[index].id;
                d.replace(id, text(&format!("edit-{i}"))).unwrap();
                expected[index].annotation = text(&format!("edit-{i}"));
                true
            }
            1 if !expected.is_empty() => {
                let index = (seed as usize) % expected.len();
                d.remove(expected[index].id).unwrap();
                expected.remove(index);
                true
            }
            2 => {
                assert_eq!(d.undo(), cursor > 0);
                cursor = cursor.saturating_sub(1);
                false
            }
            3 => {
                let available = cursor + 1 < states.len();
                assert_eq!(d.redo(), available);
                if available {
                    cursor += 1;
                }
                false
            }
            _ => {
                let annotation = mosaic();
                let id = d.add(annotation.clone()).unwrap();
                expected.push(Entry { id, annotation });
                true
            }
        };
        if changed {
            states.truncate(cursor + 1);
            states.push(expected);
            cursor += 1;
        }
        assert_eq!(d.entries(), states[cursor], "step {i}");
    }
}

fn pen(count: usize) -> Annotation {
    Annotation::Pen {
        points: vec![Point { x: 50.0, y: 50.0 }; count],
        stroke: stroke(),
    }
}

#[test]
fn ellipse_and_pen_validate_full_stroke_bounds_and_finite_points() {
    for x in [
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        -1.0,
        0.0,
        1000.0,
    ] {
        assert!(Annotation::Ellipse {
            bounds: Rect { x, ..bounds() },
            stroke: stroke()
        }
        .validate(canvas())
        .is_err());
        assert!(Annotation::Pen {
            points: vec![Point { x, y: 20.0 }],
            stroke: stroke()
        }
        .validate(canvas())
        .is_err());
    }
    assert!(Annotation::Ellipse {
        bounds: bounds(),
        stroke: stroke()
    }
    .validate(canvas())
    .is_ok());
    assert!(
        pen(1).validate(canvas()).is_ok(),
        "single brush dot is valid"
    );
    assert_eq!(pen(0).validate(canvas()), Err(Error::ResourceLimit));
    assert_eq!(
        pen(MAX_PATH_POINTS + 1).validate(canvas()),
        Err(Error::ResourceLimit)
    );
    for y in [f64::NAN, f64::INFINITY, 0.0, 800.0] {
        assert!(Annotation::Pen {
            points: vec![Point { x: 20.0, y }],
            stroke: stroke()
        }
        .validate(canvas())
        .is_err());
    }
    let full = Annotation::Ellipse {
        bounds: Rect {
            x: 1.0,
            y: 1.0,
            width: 998.0,
            height: 798.0,
        },
        stroke: stroke(),
    };
    assert!(
        full.validate(canvas()).is_ok(),
        "stroke may touch canvas edges exactly"
    );
}

#[test]
fn aggregate_path_limit_and_caller_spare_capacity_are_bounded() {
    let mut d = Document::new(canvas());
    for _ in 0..MAX_DOCUMENT_POINTS / MAX_PATH_POINTS {
        d.add(pen(MAX_PATH_POINTS)).unwrap();
    }
    let before = d.entries().to_vec();
    assert_eq!(d.add(pen(1)), Err(Error::ResourceLimit));
    assert_eq!(d.entries(), before);
    assert!(!d.can_redo());
    d.undo();
    assert!(d.can_redo());
    assert_eq!(d.add(pen(MAX_PATH_POINTS + 1)), Err(Error::ResourceLimit));
    assert!(d.can_redo(), "invalid new branch preserves original redo");
    d.redo();
    assert_eq!(d.entries(), before);
    d.undo();
    let branch = d.add(pen(1)).unwrap();
    assert!(!d.can_redo());
    assert_eq!(d.entries().last().unwrap().id, branch);
    let mut points = Vec::with_capacity(16 * MAX_PATH_POINTS);
    points.push(Point { x: 50.0, y: 50.0 });
    let mut d = Document::new(canvas());
    d.add(Annotation::Pen {
        points,
        stroke: stroke(),
    })
    .unwrap();
    match &d.entries()[0].annotation {
        Annotation::Pen { points, .. } => assert_eq!(points.capacity(), points.len()),
        _ => panic!("expected pen"),
    }
}

#[test]
fn retained_history_accounts_for_path_vectors_and_rejected_replace_is_atomic() {
    let mut d = Document::new(canvas());
    let id = d.add(pen(MAX_PATH_POINTS)).unwrap();
    let mut rejected = false;
    for i in 0..MAX_HISTORY {
        let before = d.entries().to_vec();
        let mut next = pen(MAX_PATH_POINTS);
        if let Annotation::Pen { points, .. } = &mut next {
            points[0].x += (i % 2) as f64;
        }
        if d.replace(id, next) == Err(Error::ResourceLimit) {
            assert_eq!(d.entries(), before);
            assert!(d.can_undo());
            assert!(!d.can_redo());
            rejected = true;
            break;
        }
    }
    assert!(
        rejected,
        "path vectors must count toward retained history budget"
    );
    let before = d.entries().to_vec();
    d.undo();
    assert_eq!(
        d.replace(id, pen(MAX_PATH_POINTS + 1)),
        Err(Error::ResourceLimit)
    );
    assert!(d.can_redo());
    d.redo();
    assert_eq!(d.entries(), before);
    d.undo();
    d.replace(id, pen(2)).unwrap();
    assert!(!d.can_redo());
}
