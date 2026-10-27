import 'dart:async';
import 'package:web_socket_channel/web_socket_channel.dart';

class FakeSocket implements WebSocketChannel {
  final events = StreamController<dynamic>();
  @override
  Future<void> get ready => Future.value();
  @override
  Stream<dynamic> get stream => events.stream;
  @override
  late final WebSocketSink sink = FakeSink(events);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeSink implements WebSocketSink {
  FakeSink(this.events);
  final StreamController<dynamic> events;
  @override
  Future<void> close([int? closeCode, String? closeReason]) => events.close();
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
