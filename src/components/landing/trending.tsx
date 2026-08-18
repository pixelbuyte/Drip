import { byId } from './products';
import ProductCard from './product-card';

const RANKED = ['kindling', 'ace', 'glaze', 'crescent', 'loop', 'pixelpad'];

export default function Trending() {
  return (
    <div data-enter="rise" className="rail -mx-5 px-5 md:-mx-6 md:px-6">
      {RANKED.map((id, i) => (
        <div key={id} className="w-[42vw] md:w-[240px]">
          <ProductCard product={byId(id)} rank={i + 1} />
        </div>
      ))}
    </div>
  );
}
