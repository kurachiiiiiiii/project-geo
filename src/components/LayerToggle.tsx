interface Props {
  label: string;
  visible: boolean;
  onVisibleChange: (v: boolean) => void;
  count?: number;
  loading?: boolean;
  error?: string | null;
}

/** 「表示/非表示チェックボックス + 件数/エラー表示」の共通レイヤー切り替えUI */
export default function LayerToggle({ label, visible, onVisibleChange, count, loading, error }: Props) {
  return (
    <div className="layer-control">
      <label className="layer-control__checkbox">
        <input type="checkbox" checked={visible} onChange={(e) => onVisibleChange(e.target.checked)} />
        {label}
      </label>
      {loading && <div className="layer-control__status">読み込み中...</div>}
      {!loading && !error && count !== undefined && <div className="layer-control__status">{count}件</div>}
      {error && <div className="layer-control__error">{error}</div>}
    </div>
  );
}
