import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:web/main.dart';
import 'package:web/api/transport.dart';

void main() {
  testWidgets('login, protected whoami, logout use generated API paths', (tester) async {
    final calls = <String>[];
    final client = MockClient((request) async {
      calls.add(request.url.path);
      switch (request.url.path) {
        case '/api/v1/auth/v1/login':
          expect(request.method, 'POST');
          expect(jsonDecode(request.body)['username'], 'alice');
          expect(request.headers.containsKey('Authorization'), false);
          return http.Response(jsonEncode({'user_id': 'user-123', 'access_token': 'test-token', 'token_type': 'Bearer', 'expires_in': 3600}), 200);
        case '/api/v1/whoami/v1/user-id':
          expect(request.headers['Authorization'], 'Bearer test-token');
          expect(request.headers.containsKey('X-Verified-User-Id'), false);
          return http.Response('{"user_id":"user-123"}', 200);
        case '/api/v1/auth/v1/logout':
          expect(request.headers['Authorization'], 'Bearer test-token');
          return http.Response('', 204);
        default: throw StateError('Unexpected API request');
      }
    });
    await tester.pumpWidget(SoloApp(transport: ApiTransport(client: client, origin: Uri.parse('https://example.invalid'))));
    await tester.enterText(find.byType(TextField).at(0), 'alice');
    await tester.enterText(find.byType(TextField).at(1), 'password-long-enough');
    await tester.tap(find.text('Войти')); await tester.pumpAndSettle();
    expect(find.text('user-123'), findsOneWidget);
    await tester.tap(find.text('Проверить через Whoami')); await tester.pumpAndSettle();
    expect(find.textContaining('Whoami подтвердил'), findsOneWidget);
    await tester.tap(find.text('Выйти')); await tester.pumpAndSettle();
    expect(find.text('Вход в аккаунт'), findsOneWidget);
    expect(calls.length, 3);
  });

  testWidgets('401 keeps login form and presents an error', (tester) async {
    await tester.pumpWidget(SoloApp(transport: ApiTransport(
      origin: Uri.parse('https://example.invalid'),
      client: MockClient((_) async => http.Response('{"error":"unauthorized"}', 401)))));
    await tester.tap(find.text('Войти')); await tester.pumpAndSettle();
    expect(find.text('Вход в аккаунт'), findsOneWidget);
    expect(find.textContaining('Неверный пароль'), findsOneWidget);
  });
}
