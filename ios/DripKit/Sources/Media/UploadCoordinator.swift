import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Uploads a recorded/picked video to a Mux direct-upload URL (returned by
/// the backend — the Mux token never reaches the device). Mux direct uploads
/// accept a single PUT of the file body.
public struct UploadProgress: Sendable, Equatable {
    public var sentBytes: Int64
    public var totalBytes: Int64
    public var fraction: Double { totalBytes > 0 ? Double(sentBytes) / Double(totalBytes) : 0 }
}

public enum UploadError: Error, Sendable, Equatable {
    case fileMissing
    case tooLarge(bytes: Int64)
    case rejected(status: Int)
    case transport(message: String)
}

public enum UploadLimits {
    /// Keep in step with the web composer; Mux itself allows far more.
    public static let maxBytes: Int64 = 1_000_000_000
}

#if canImport(Darwin)
public struct UploadCoordinator: Sendable {
    public init() {}

    public func upload(file: URL, to uploadURL: URL,
                       progress: @escaping @Sendable (UploadProgress) -> Void) async throws {
        let attributes = try? FileManager.default.attributesOfItem(atPath: file.path)
        guard let size = (attributes?[.size] as? NSNumber)?.int64Value else { throw UploadError.fileMissing }
        guard size <= UploadLimits.maxBytes else { throw UploadError.tooLarge(bytes: size) }

        var request = URLRequest(url: uploadURL, timeoutInterval: 300)
        request.httpMethod = "PUT"
        request.setValue(file.pathExtension.lowercased() == "mp4" ? "video/mp4" : "video/quicktime",
                         forHTTPHeaderField: "Content-Type")

        let config = URLSessionConfiguration.default
        config.httpCookieStorage = nil
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }

        let response: URLResponse
        do {
            (_, response) = try await session.upload(for: request, fromFile: file,
                                                     delegate: ProgressDelegate(onProgress: progress))
        } catch {
            throw UploadError.transport(message: error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw UploadError.rejected(status: status) }
        progress(UploadProgress(sentBytes: size, totalBytes: size))
    }

    private final class ProgressDelegate: NSObject, URLSessionTaskDelegate, Sendable {
        let onProgress: @Sendable (UploadProgress) -> Void
        init(onProgress: @escaping @Sendable (UploadProgress) -> Void) { self.onProgress = onProgress }

        func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                        totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
            onProgress(UploadProgress(sentBytes: totalBytesSent, totalBytes: totalBytesExpectedToSend))
        }
    }
}
#endif
