#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import AVFoundation
import DripModels
import DesignSystem
import Media

/// One page of the feed — frame 40, "the living shelf": full-bleed video,
/// a bottom scrim with the creator row and a serif caption, one horizontal
/// social row, then the shelf card with the featured product and "Peek".
struct FeedPage: View {
    struct Actions {
        var like: () -> Void
        var doubleTapLike: () -> Void
        var save: () -> Void
        var follow: () -> Void
        var shared: () -> Void
        var openCreator: () -> Void
        var peek: (FeedProduct) -> Void
        var toggleMute: () -> Void
        var togglePlayback: () -> Void
        var retry: () -> Void
        var notInterested: () -> Void
        var report: () -> Void
    }

    let item: FeedItem
    let player: AVPlayer?
    let isActive: Bool
    let failed: Bool
    let isLiked: Bool
    let isSaved: Bool
    let isFollowing: Bool
    let muted: Bool
    let shareURL: URL
    let actions: Actions

    @State private var burst = false
    @State private var playHint = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .bottom) {
            media
            LinearGradient(colors: [.clear, .black.opacity(0.6)], startPoint: .center, endPoint: .bottom)
                .allowsHitTesting(false)
            overlay
        }
        .clipped()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Video by \(item.seller.displayName)")
    }

    // MARK: Media

    private var media: some View {
        ZStack {
            Color.black
            if let poster = item.thumbnailUrl ?? item.playbackId.flatMap({ MuxURLs.thumbnail(playbackId: $0)?.absoluteString }) {
                RemoteImage(poster)
            }
            if let player, !failed {
                PlayerLayerView(player: player)
            }
            if failed {
                VStack(spacing: DripSpace.s) {
                    Text("This video didn't load.").dripText(.body).foregroundStyle(.white)
                    Button("Try again", action: actions.retry).buttonStyle(.drip(.onMedia, fullWidth: false))
                }
            } else if item.playbackId == nil {
                Text("Video is still processing").dripText(.meta).foregroundStyle(.white.opacity(0.8))
            }
            if burst {
                Image(systemName: "heart.fill")
                    .font(.system(size: DripSize.likeBurstMax * 1.6))
                    .foregroundStyle(DripColor.coral)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                    .accessibilityHidden(true)
            }
            if playHint {
                Image(systemName: "playpause.fill")
                    .font(.title2).foregroundStyle(.white)
                    .padding(DripSpace.m).background(.black.opacity(0.35), in: Circle())
                    .transition(.opacity)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
        // iOS convention: tap pauses/plays, double tap likes. Mute is its
        // own button in the social row (the web toggles mute on tap).
        .onTapGesture(count: 2) { doubleTap() }
        .onTapGesture {
            actions.togglePlayback()
            flashHint()
        }
        .accessibilityAction(named: "Pause or play", actions.togglePlayback)
        .accessibilityAction(named: "Like", actions.doubleTapLike)
    }

    private func doubleTap() {
        actions.doubleTapLike()
        guard !reduceMotion else { return }
        withAnimation(DripMotion.standard(DripMotionSpec.likeMs)) { burst = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            withAnimation(DripMotion.standard(DripMotionSpec.releaseMs)) { burst = false }
        }
    }

    private func flashHint() {
        withAnimation(.easeOut(duration: 0.12)) { playHint = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            withAnimation(.easeOut(duration: 0.2)) { playHint = false }
        }
    }

    // MARK: Overlay

    private var overlay: some View {
        VStack(alignment: .leading, spacing: DripSpace.s) {
            creatorRow
            if let caption = item.caption, !caption.isEmpty {
                Text(caption)
                    .font(.custom("InstrumentSerif-Regular", size: 30, relativeTo: .title))
                    .foregroundStyle(.white)
                    .lineLimit(3)
                    .shadow(color: .black.opacity(0.35), radius: 6)
            }
            if !item.hashtags.isEmpty {
                Text(item.hashtags.prefix(4).map { "#\($0)" }.joined(separator: " "))
                    .dripText(.meta).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
            }
            socialRow
            LivingShelf(item: item, onPeek: actions.peek)
        }
        .padding(.horizontal, DripSpace.insetCompact)
        .padding(.bottom, DripSpace.s)
        .safeAreaPadding(.bottom, DripSize.tabBar)
    }

    private var creatorRow: some View {
        HStack(spacing: DripSpace.xs) {
            Button(action: actions.openCreator) {
                HStack(spacing: DripSpace.xs) {
                    CreatorAvatar(url: item.seller.avatarUrl, name: item.seller.displayName,
                                  size: DripSize.avatarMedium, ringed: true)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(item.seller.displayName).dripText(.product).foregroundStyle(.white)
                        Text("@\(item.seller.handle)").dripText(.meta).foregroundStyle(.white.opacity(0.8))
                    }
                }
                .frame(minHeight: DripSize.minHit)
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel("\(item.seller.displayName), view profile")
            FollowButton(isFollowing: isFollowing, onMedia: true, action: actions.follow)
            Spacer()
        }
    }

    private var socialRow: some View {
        HStack(spacing: DripSpace.xs) {
            SocialActionButton(.like, isActive: isLiked, action: actions.like)
            SocialActionButton(.save, isActive: isSaved, action: actions.save)
            ShareLink(item: shareURL,
                      subject: Text(item.products.first?.title ?? "Found on Drip"),
                      message: Text(shareMessage)) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: DripSize.minHit, height: DripSize.minHit)
            }
            .simultaneousGesture(TapGesture().onEnded { actions.shared() })
            .accessibilityLabel("Share")
            Spacer()
            Button(action: actions.toggleMute) {
                Image(systemName: muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: DripSize.minHit, height: DripSize.minHit)
            }
            .accessibilityLabel(muted ? "Unmute" : "Mute")
            Menu {
                Button("Not interested", systemImage: "eye.slash", action: actions.notInterested)
                Button("Report", systemImage: "flag", role: .destructive, action: actions.report)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: DripSize.minHit, height: DripSize.minHit)
            }
            .accessibilityLabel("More options")
        }
    }

    private var shareMessage: String {
        if let p = item.products.first {
            return "\(p.title) from @\(item.seller.handle) on Drip"
        }
        return "@\(item.seller.handle) on Drip"
    }
}

/// The floating cream shelf: featured product + "Peek", and a "N in this
/// look" row when the video tags more than one product.
struct LivingShelf: View {
    let item: FeedItem
    let onPeek: (FeedProduct) -> Void

    var body: some View {
        let sorted = item.products.sorted { $0.position < $1.position }
        if let featured = sorted.first {
            VStack(spacing: 0) {
                HStack(spacing: DripSpace.s) {
                    RemoteImage(featured.images.first)
                        .frame(width: DripSize.shelfThumb, height: DripSize.shelfThumb)
                        .clipShape(RoundedRectangle(cornerRadius: DripRadius.thumbnail, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(featured.title).dripText(.product).foregroundStyle(DripColor.ink).lineLimit(1)
                        HStack(spacing: 6) {
                            PriceTag(price: featured.price, compareAt: featured.compareAtPrice)
                            if featured.isSoldOut {
                                DripBadge("Sold out", style: .neutral)
                            } else if featured.isLowStock {
                                Text("\(featured.inventoryCount) left").dripText(.meta).foregroundStyle(DripColor.saleText)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                    Button("Peek") { onPeek(featured) }
                        .buttonStyle(PillButtonStyle())
                        .accessibilityLabel("Peek \(featured.title)")
                }
                .padding(DripSpace.s)

                if sorted.count > 1 {
                    Divider().overlay(DripColor.hairlineStrong)
                    Menu {
                        ForEach(sorted) { p in
                            Button("\(p.title) · \(p.price.formatted)") { onPeek(p) }
                        }
                    } label: {
                        HStack(spacing: DripSpace.xs) {
                            HStack(spacing: -10) {
                                ForEach(sorted.prefix(3)) { p in
                                    RemoteImage(p.images.first)
                                        .frame(width: 28, height: 28)
                                        .clipShape(Circle())
                                        .overlay(Circle().strokeBorder(DripColor.cream, lineWidth: 2))
                                }
                            }
                            Text("\(sorted.count) in this look").dripText(.meta).foregroundStyle(DripColor.ink)
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(DripColor.muted)
                        }
                        .padding(.horizontal, DripSpace.s)
                        .frame(minHeight: DripSize.minHit)
                    }
                    .accessibilityLabel("Shop this look, \(sorted.count) items")
                }
            }
            .background(DripColor.cream, in: RoundedRectangle(cornerRadius: DripRadius.tile, style: .continuous))
            .dripShadow(.floatingShelf)
        }
    }
}
#endif
