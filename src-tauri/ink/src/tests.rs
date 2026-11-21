use super::*;

fn payload(version: u8, color: u32, width: f32, points: &[(f32, f32, f32)]) -> Vec<u8> {
    let mut bytes = vec![version];
    bytes.extend(color.to_le_bytes());
    if version == 2 {
        bytes.extend(width.to_le_bytes());
    }
    bytes.extend((points.len() as u32).to_le_bytes());
    for (x, y, _) in points {
        bytes.extend(x.to_le_bytes());
        bytes.extend(y.to_le_bytes());
    }
    for (_, _, pressure) in points {
        bytes.extend(pressure.to_le_bytes());
    }
    bytes
}

fn stroke(points: &[(f32, f32)]) -> Stroke {
    Stroke {
        color: 0xff00_0000,
        width: 4.0,
        points: points
            .iter()
            .map(|&(x, y)| Point {
                x,
                y,
                pressure: 1.0,
            })
            .collect(),
    }
}

#[test]
fn decodes_both_versions_and_sanitizes_like_the_editor() {
    let v2 = decode_payload(&payload(
        2,
        0x8012_3456,
        f32::NAN,
        &[(1.5, -2.0, 0.0), (3.0, 4.0, 2.0)],
    ))
    .unwrap();
    assert_eq!(v2.color, 0x8012_3456);
    assert_eq!(v2.width, 4.0);
    assert_eq!(
        v2.points,
        vec![
            Point {
                x: 1.5,
                y: -2.0,
                pressure: 1.0
            },
            Point {
                x: 3.0,
                y: 4.0,
                pressure: 1.0
            },
        ]
    );
    let v1 = decode_payload(&payload(1, 7, 0.0, &[(5.0, 6.0, 0.5)])).unwrap();
    assert_eq!((v1.color, v1.width), (7, 4.0));
    assert_eq!(
        v1.points,
        vec![Point {
            x: 5.0,
            y: 6.0,
            pressure: 0.5
        }]
    );
}

#[test]
fn rejects_malformed_payloads() {
    let good = payload(2, 0, 2.0, &[(1.0, 2.0, 1.0)]);
    assert!(decode_payload(&good[..good.len() - 1]).is_none());
    assert!(decode_payload(&[good.as_slice(), &[0]].concat()).is_none());
    assert!(decode_payload(&[3, 0, 0, 0, 0, 0, 0, 0, 0]).is_none());
    assert!(decode_payload(&[2, 0, 0, 0, 0]).is_none());
    assert!(decode_payload(&[1, 0, 0, 0]).is_none());
    assert!(decode_payload(&[]).is_none());
    let mut huge = payload(1, 0, 0.0, &[]);
    huge[5..9].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(decode_payload(&huge).is_none());
}

#[test]
fn signature_follows_geometry_not_style() {
    let page = vec![stroke(&[(10.0, 10.0), (20.4, 30.0)]), stroke(&[(5.0, 5.0)])];
    // Stored in notes: changing it makes every recognizer read every page again.
    assert_eq!(signature(&page), "2:14n43u4");
    assert_eq!(signature(&[]), "0:ztntfp");

    let mut restyled = page.clone();
    restyled[0].color = 0xffff_0000;
    restyled[0].width = 9.0;
    assert_eq!(signature(&restyled), signature(&page));

    let mut moved = page.clone();
    moved[0].points[1].x = 21.4;
    assert_ne!(signature(&moved), signature(&page));
}

fn decode_png(bytes: &[u8]) -> Pixmap {
    Pixmap::decode_png(bytes).unwrap()
}

#[test]
fn renders_strokes_cropped_with_padding_on_white() {
    let mut wide = stroke(&[(100.0, 200.0), (300.0, 200.0)]);
    wide.width = 64.0;
    let image = decode_png(&render_png(&[wide]).unwrap());
    // The painted edge, not the centre line, gets the padding.
    assert_eq!((image.width(), image.height()), (312, 112));
    let at = |x, y| image.pixel(x, y).unwrap();
    assert_eq!(at(156, 0).red(), 255);
    assert_eq!(at(156, 22).red(), 255);
    assert_eq!(at(156, 26).red(), 0);
    assert_eq!(at(156, 56).alpha(), 255);
    assert_eq!(at(156, 56).red(), 0);
}

#[test]
fn scales_large_pages_down_and_keeps_lone_points() {
    let wide = render_png(&[
        stroke(&[(0.0, 0.0), (4000.0, 0.0)]),
        stroke(&[(2000.0, 500.0)]),
    ])
    .unwrap();
    let image = decode_png(&wide);
    assert_eq!(image.width(), MAX_SIDE as u32);
    assert!(image.height() < 300);
    let scale = MAX_SIDE / 4048.0;
    let dot = image
        .pixel(
            ((2000.0 + PADDING) * scale) as u32,
            ((500.0 + PADDING) * scale) as u32,
        )
        .unwrap();
    assert!(dot.red() < 128, "the lone point should be drawn");
}

#[test]
fn renders_nothing_without_finite_points() {
    assert!(render_png(&[]).is_none());
    assert!(render_png(&[stroke(&[(f32::NAN, 1.0)])]).is_none());
}
