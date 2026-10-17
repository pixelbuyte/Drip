import Foundation
#if canImport(Security)
import Security
#endif

/// Where the refresh token and the signed viewer identity live. Never
/// UserDefaults: both are bearer credentials.
public protocol SecureStore: Sendable {
    func data(for key: String) throws -> Data?
    func set(_ data: Data, for key: String) throws
    func remove(_ key: String) throws
}

public enum SecureStoreError: Error, Sendable, Equatable {
    case status(Int32)
}

public extension SecureStore {
    func value<T: Decodable>(_ type: T.Type, for key: String) -> T? {
        guard let data = try? data(for: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    func setValue<T: Encodable>(_ value: T, for key: String) throws {
        try set(JSONEncoder().encode(value), for: key)
    }
}

/// Tests and previews.
public final class InMemorySecureStore: SecureStore, @unchecked Sendable {
    private var storage: [String: Data] = [:]
    private let lock = NSLock()

    public init() {}

    public func data(for key: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        return storage[key]
    }

    public func set(_ data: Data, for key: String) throws {
        lock.lock(); defer { lock.unlock() }
        storage[key] = data
    }

    public func remove(_ key: String) throws {
        lock.lock(); defer { lock.unlock() }
        storage[key] = nil
    }
}

#if canImport(Security)
/// Generic-password items, this device only, readable after first unlock so
/// a background event flush or token refresh still works on a locked phone.
/// Not synced to iCloud Keychain: a session token belongs to one device.
public struct KeychainStore: SecureStore {
    private let service: String

    public init(service: String) {
        self.service = service
    }

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    public func data(for key: String) throws -> Data? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SecureStoreError.status(status) }
        return out as? Data
    }

    public func set(_ data: Data, for key: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query(key) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = query(key)
            add.merge(attributes) { $1 }
            let added = SecItemAdd(add as CFDictionary, nil)
            guard added == errSecSuccess else { throw SecureStoreError.status(added) }
        } else if status != errSecSuccess {
            throw SecureStoreError.status(status)
        }
    }

    public func remove(_ key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SecureStoreError.status(status)
        }
    }
}
#endif
