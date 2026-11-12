import { useTranslation } from 'react-i18next';

export function Checkout({ items, user }) {
  const { t } = useTranslation();
  const count = items.length;
  return (
    <div className="checkout">
      <h1>{t('checkout.title', 'Your basket')}</h1>
      <p>{t('cart.you', 'You have') + ' ' + count + ' ' + t('cart.items', 'items')}</p>
      <p>{count} {t('cart.itemsLabel')}</p>
      <p>{count === 1 ? 'item' : 'items'}</p>
      <input placeholder="Enter discount code" />
      <button onClick={() => pay()}>
        Pay now
      </button>
      <button aria-label={t('dialog.closeAction', 'Close')}>×</button>
      <button>{t('save2', 'Save')}</button>
      <button>{t('document.saveAction', 'Save')}</button>
      <span>{t(`status.${user.status}`)}</span>
      <p>{t('cart.summary', '{count, plural, one {You have # item} other {You have # items}}', { count })}</p>
      <p>{t('inbox.unread', { count })}</p>
      <p>{t('cart.remaining', { count })}</p>
      <button>{t('checkout.payButton', 'Pay now!')}</button>
    </div>
  );
}

function pay() {
  toast.error('Payment failed, please try again');
}
