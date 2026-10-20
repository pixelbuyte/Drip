#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import DripModels
import DesignSystem
import Media

/// 9:16 poster with creator and lead product price — used by search,
/// creator profiles and saved items.
public struct VideoTile: View {
    let item: FeedItem

    public init(item: FeedItem) { self.item = item }

    public var body: some View {
        ZStack(alignment: .bottomLeading) {
            RemoteImage(item.thumbnailUrl ?? item.playbackId.flatMap { MuxURLs.thumbnail(playbackId: $0, width: 360)?.absoluteString })
            LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .center, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 2) {
                if let p = item.products.first {
                    Text(p.title).dripText(.meta).foregroundStyle(.white).lineLimit(1)
                    Text(p.price.formatted).font(.drip(.meta).weight(.bold)).foregroundStyle(.white)
                }
                Text("@\(item.seller.handle)").font(.drip(.nav)).foregroundStyle(.white.opacity(0.85))
            }
            .padding(DripSpace.xs)
            Image(systemName: "play.fill").font(.caption).foregroundStyle(.white)
                .padding(6).background(.black.opacity(0.3), in: Circle())
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                .padding(DripSpace.xs)
        }
        .aspectRatio(9.0 / 16.0, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: DripRadius.tile, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(.isButton)
    }

    private var accessibilityText: String {
        if let p = item.products.first { return "\(p.title), \(p.price.formatted), by \(item.seller.displayName)" }
        return "Video by \(item.seller.displayName)"
    }
}
#endif
