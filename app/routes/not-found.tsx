import { data, Link } from 'react-router';

export function loader() {
  return data(null, { status: 404 });
}

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-xl py-16 text-center">
      <p className="text-xs font-semibold tracking-[0.18em] text-ink-subtle uppercase">
        404
      </p>
      <h2 className="mt-4 text-3xl font-semibold tracking-tight text-ink">
        ページが見つかりません
      </h2>
      <p className="mt-6">
        <Link
          to="/"
          className={[
            'inline-flex rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink',
            'transition-colors duration-150 hover:bg-accent-hover',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          ].join(' ')}
        >
          一覧へ戻る
        </Link>
      </p>
    </div>
  );
}
