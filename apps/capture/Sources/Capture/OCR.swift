import Foundation
import Vision
import AppKit

final class OCR {
    static let shared = OCR()

    private let queue = DispatchQueue(
        label: "com.kealjones.apotheosis.ocr",
        qos: .background
    )

    private init() {}

    // MARK: - Public API

    func enqueue(path: String, sampleId: Int64) {
        queue.async { [weak self] in
            self?.process(path: path, sampleId: sampleId)
        }
    }

    // MARK: - Worker

    private func process(path: String, sampleId: Int64) {
        // Screenshot is no longer needed once OCR finishes (success or not) - all
        // downstream tools use stored ocr_text. Delete to save disk space.
        // (delete_samples.ts handles missing files gracefully.)
        defer { try? FileManager.default.removeItem(atPath: path) }

        guard
            let image = NSImage(contentsOfFile: path),
            let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        else {
            print("[OCR] Could not load image at \(path)")
            return
        }

        let requestHandler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

        do {
            try requestHandler.perform([request])
        } catch {
            print("[OCR] Recognition failed: \(error)")
            return
        }

        guard let observations = request.results else { return }

        let text = observations
            .compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: "\n")

        guard !text.isEmpty else { return }

        Store.shared.updateOCR(id: sampleId, text: text)
        print("[OCR] Updated sample \(sampleId) with \(text.count) chars")
    }
}
