import { data, Link } from "react-router";

export function loader() {
  return data(null, { status: 404 });
}

export default function NotFound() {
  return (
    <section>
      <h2>ページが見つかりません</h2>
      <p>
        <Link to="/">一覧へ戻る</Link>
      </p>
    </section>
  );
}
