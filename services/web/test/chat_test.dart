import 'dart:convert';
import 'fake_socket.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soloapp_web/api/transport.dart';
import 'package:soloapp_web/views/chat.dart';

void main() {
  testWidgets(
    'authorized chat reads other users and retries send with the same id',
    (tester) async {
      final ids = <String>[];
      final socket = FakeSocket();
      var tickets = 0;
      final transport = ApiTransport(
        origin: Uri.parse('https://example.invalid'),
        socketConnector: (uri, protocols) {
          expect(
            uri.toString(),
            'wss://example.invalid/api/v1/app-api/v1/chat/ws',
          );
          expect(protocols, ['soloapp.chat.v1', 'ticket.fixture']);
          return socket;
        },
        client: MockClient((request) async {
          if (request.url.path.endsWith('/socket-ticket')) {
            tickets++;
            return http.Response('{"ticket":"fixture","expires_in":30}', 201);
          }
          expect(request.url.path, '/api/v1/app-api/v1/chat/messages');
          expect(request.headers['Authorization'], 'Bearer test-token');
          final message = {
            'id': '1-0',
            'user_id': 'ab' * 16,
            'text': 'Привет всем',
            'sent_at': 1000,
          };
          if (request.method == 'GET') {
            return http.Response(
              jsonEncode({
                'messages': [message],
              }),
              200,
              headers: {'content-type': 'application/json; charset=utf-8'},
            );
          }
          final data = jsonDecode(request.body) as Map<String, dynamic>;
          expect(data.keys.toSet(), {'text', 'client_id'});
          expect(data['text'], 'Hello');
          ids.add(data['client_id'] as String);
          return http.Response(
            jsonEncode(message),
            ids.length == 1 ? 503 : 201,
          );
        }),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: ChatPanel(
                transport: transport,
                token: 'test-token',
                userId: 'cd' * 16,
                onExpired: () => fail('not expired'),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      socket.events.add(
        jsonEncode({
          'type': 'message',
          'message': {
            'id': '1-0',
            'user_id': 'ab' * 16,
            'text': 'Привет всем',
            'sent_at': 1000,
          },
        }),
      );
      await tester.pumpAndSettle();
      expect(find.text('Привет всем'), findsOneWidget);
      await tester.pump(const Duration(seconds: 5));
      expect(tickets, 1); // No two-second history polling.

      await tester.enterText(find.byKey(const Key('chat-input')), 'Hello');
      await tester.ensureVisible(find.text('Отправить'));
      await tester.tap(find.text('Отправить'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('chat-error')), findsOneWidget);
      await tester.ensureVisible(find.text('Отправить'));
      await tester.tap(find.text('Отправить'));
      await tester.pumpAndSettle();
      expect(ids.length, 2);
      expect(ids[0], ids[1]);
      await tester.pumpWidget(const SizedBox());
      transport.close();
    },
  );

  testWidgets(
    'reconnects with a fresh ticket and merges replay without duplicates',
    (tester) async {
      final sockets = [FakeSocket(), FakeSocket()];
      var connections = 0;
      var tickets = 0;
      final transport = ApiTransport(
        origin: Uri.parse('https://example.invalid'),
        client: MockClient((request) async {
          expect(request.url.path.endsWith('/socket-ticket'), true);
          tickets++;
          return http.Response('{"ticket":"fixture","expires_in":30}', 201);
        }),
        socketConnector: (_, _) => sockets[connections++],
      );
      final message = {
        'id': '1-0',
        'user_id': 'ab' * 16,
        'text': 'once',
        'sent_at': 1000,
      };
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ChatPanel(
              transport: transport,
              token: 'test',
              userId: 'ab' * 16,
              onExpired: () => fail('not expired'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      sockets[0].events.add(
        jsonEncode({'type': 'message', 'message': message}),
      );
      await tester.pumpAndSettle();
      sockets[0].events.close();
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(tickets, 2);
      expect(connections, 2);
      sockets[1].events.add(
        jsonEncode({
          'type': 'history',
          'messages': [message],
        }),
      );
      await tester.pumpAndSettle();
      expect(find.text('once'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      transport.close();
    },
  );

  testWidgets('revoked session prevents WebSocket connection', (tester) async {
    var expired = false;
    final transport = ApiTransport(
      client: MockClient((_) async => http.Response('{}', 401)),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: ChatPanel(
              transport: transport,
              token: 'expired',
              userId: 'ab' * 16,
              onExpired: () => expired = true,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(expired, true);
    await tester.pumpWidget(const SizedBox());
    transport.close();
  });
}
