// Renders the app icon (a gold-rimmed dark square with a prompt chevron and three status bars) into an .iconset folder.
// Drawn in a 120x120 design space (the same coordinates as public/icon.svg), padded to the macOS icon grid.
// Usage: swift make-icon.swift <out.iconset>
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func rgb(_ hex: UInt32) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let gold = CGGradient(colorsSpace: space, colors: [rgb(0xf4dfaa), rgb(0xb3843a)] as CFArray, locations: [0, 1])!
let body = CGGradient(colorsSpace: space, colors: [rgb(0x232228), rgb(0x0d0d10)] as CFArray, locations: [0, 1])!

func render(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!.cgContext
    // design space: x, y in 0...120 with y pointing down, centred with a 12.08 margin each side (144.16 total)
    let k = CGFloat(px) / 144.16
    ctx.translateBy(x: 0, y: CGFloat(px))
    ctx.scaleBy(x: k, y: -k)
    ctx.translateBy(x: 12.08, y: 12.08)
    let diag = (CGPoint(x: 0, y: 0), CGPoint(x: 120, y: 120))

    // the square: dark vertical gradient, gold diagonal-gradient rim
    let square = CGPath(roundedRect: CGRect(x: 2, y: 2, width: 116, height: 116), cornerWidth: 27, cornerHeight: 27, transform: nil)
    ctx.saveGState()
    ctx.addPath(square); ctx.clip()
    ctx.drawLinearGradient(body, start: CGPoint(x: 0, y: 2), end: CGPoint(x: 0, y: 118), options: [])
    ctx.restoreGState()
    func strokeGold(_ path: CGPath, width: CGFloat) {
        ctx.saveGState()
        ctx.addPath(path); ctx.setLineWidth(width); ctx.setLineCap(.round); ctx.setLineJoin(.round)
        ctx.replacePathWithStrokedPath(); ctx.clip()
        ctx.drawLinearGradient(gold, start: diag.0, end: diag.1, options: [])
        ctx.restoreGState()
    }
    strokeGold(square, width: 2)

    // the prompt chevron
    let chevron = CGMutablePath()
    chevron.move(to: CGPoint(x: 30, y: 42)); chevron.addLine(to: CGPoint(x: 48, y: 60)); chevron.addLine(to: CGPoint(x: 30, y: 78))
    strokeGold(chevron, width: 7)

    // three agents: waiting (amber), working (green), idle (grey)
    ctx.setLineWidth(6); ctx.setLineCap(.round)
    for (y, x2, color) in [(44.0, 90.0, 0xf0b44a), (60.0, 84.0, 0x5fcf8a), (76.0, 78.0, 0x6b6872)] as [(CGFloat, CGFloat, UInt32)] {
        ctx.setStrokeColor(rgb(color))
        ctx.move(to: CGPoint(x: 60, y: y)); ctx.addLine(to: CGPoint(x: x2, y: y)); ctx.strokePath()
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
    try render(base).write(to: out.appendingPathComponent("icon_\(base)x\(base).png"))
    try render(base * 2).write(to: out.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
