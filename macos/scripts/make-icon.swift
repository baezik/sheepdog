// Renders the app icon (🐶 on a dark rounded square) into an .iconset folder.
// Usage: swift make-icon.swift <out.iconset>
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px)
    // macOS icon grid: 824/1024 body with a soft shadow margin
    let inset = s * 100 / 1024
    let rect = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let path = NSBezierPath(roundedRect: rect, xRadius: rect.width * 0.225, yRadius: rect.width * 0.225)
    NSGradient(colors: [NSColor(srgbRed: 0.20, green: 0.21, blue: 0.24, alpha: 1), NSColor(srgbRed: 0.10, green: 0.10, blue: 0.12, alpha: 1)])!
        .draw(in: path, angle: -90)
    NSColor(srgbRed: 0.96, green: 0.65, blue: 0.14, alpha: 1).setStroke()
    path.lineWidth = max(1, s * 0.018)
    path.stroke()
    let emoji = NSAttributedString(string: "🐶", attributes: [.font: NSFont.systemFont(ofSize: rect.width * 0.62)])
    let size = emoji.size()
    emoji.draw(at: NSPoint(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2 - rect.height * 0.02))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
    try render(base).write(to: out.appendingPathComponent("icon_\(base)x\(base).png"))
    try render(base * 2).write(to: out.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
