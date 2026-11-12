import 'package:flutter/material.dart';
import 'l10n/app_localizations.dart';

class CheckoutPage extends StatelessWidget {
  const CheckoutPage({super.key, required this.count});
  final int count;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.checkoutTitle)),
      body: Column(children: [
        Text(l10n.youHave + ' $count ' + l10n.items),
        Text('${l10n.youHave} $count ${l10n.items}'),
        Text('You have $count items in your basket'),
        Text(count == 1 ? 'item' : 'items'),
        TextField(decoration: InputDecoration(hintText: 'Enter discount code')),
        IconButton(icon: const Icon(Icons.close), tooltip: 'Close', onPressed: () {}),
        ElevatedButton(onPressed: () => _pay(context), child: const Text('Pay now')),
        Text(l10n.cartItemCount(count)),
        Text(l10n.itemsLeft(count)),
        Text(l10n.checkoutSubtitle),
        Image.asset('assets/images/logo.png'),
        Navigator(key: const ValueKey('checkout_nav'), initialRoute: '/checkout'),
      ]),
    );
  }

  void _pay(BuildContext context) {
    debugPrint('Payment started for $count items');
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Payment failed, please try again')),
    );
  }
}
