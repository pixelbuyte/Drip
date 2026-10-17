import Foundation

/// Screen state. `empty` is distinct from `loaded([])` so a view never has to
/// guess whether "no rows" means "still loading" or "nothing there".
public enum Loadable<Value: Sendable>: Sendable {
    case idle
    case loading
    case loaded(Value)
    case empty
    case failed(message: String)

    public var value: Value? {
        if case .loaded(let v) = self { return v }
        return nil
    }

    public var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }

    public var errorMessage: String? {
        if case .failed(let m) = self { return m }
        return nil
    }
}

extension Loadable: Equatable where Value: Equatable {}
