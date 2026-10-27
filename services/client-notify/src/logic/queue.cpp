#include "queue.hpp"
#include <amqp_ssl_socket.h>
#include <amqp_tcp_socket.h>
#include <stdexcept>
#include <sys/socket.h>
namespace solo::notify {
void Queue::Check(amqp_rpc_reply_t reply) {
    if (reply.reply_type != AMQP_RESPONSE_NORMAL)
        throw std::runtime_error("RabbitMQ operation failed");
}
Queue::Queue(const Config &c, bool consumer) : connection_(amqp_new_connection()), queue_(c.queue) {
    if (!connection_)
        throw std::runtime_error("RabbitMQ allocation failed");
    try {
        amqp_socket_t *sock;
        if (c.rabbit_tls) {
            sock = amqp_ssl_socket_new(connection_);
            if (!sock)
                throw std::runtime_error("TLS allocation failed");
            amqp_ssl_socket_set_verify_peer(sock, 1);
            amqp_ssl_socket_set_verify_hostname(sock, 1);
            if (amqp_ssl_socket_set_cacert(sock, c.rabbit_ca.c_str()) != AMQP_STATUS_OK)
                throw std::runtime_error("RabbitMQ CA invalid");
        } else
            sock = amqp_tcp_socket_new(connection_);
        timeval timeout{3, 0};
        amqp_set_rpc_timeout(connection_, &timeout);
        amqp_set_handshake_timeout(connection_, &timeout);
        if (amqp_socket_open_noblock(sock, c.rabbit_host.c_str(), c.rabbit_port, &timeout) !=
            AMQP_STATUS_OK)
            throw std::runtime_error("RabbitMQ unavailable");
        socket_ = amqp_get_sockfd(connection_);
        Check(amqp_login(connection_, "/soloapp", 0, 131072, 30, AMQP_SASL_METHOD_PLAIN,
                         c.rabbit_user.c_str(), c.rabbit_password.c_str()));
        amqp_channel_open(connection_, 1);
        Check(amqp_get_rpc_reply(connection_));
        // Passive declaration: runtime cannot change the operator-managed quorum queue.
        amqp_queue_declare(connection_, 1, amqp_cstring_bytes(queue_.c_str()), 1, 1, 0, 0,
                           amqp_empty_table);
        Check(amqp_get_rpc_reply(connection_));
        if (consumer) {
            amqp_basic_qos(connection_, 1, 0, 1, 0);
            Check(amqp_get_rpc_reply(connection_));
            amqp_basic_consume(connection_, 1, amqp_cstring_bytes(queue_.c_str()), amqp_empty_bytes,
                               0, 0, 0, amqp_empty_table);
            Check(amqp_get_rpc_reply(connection_));
        } else {
            amqp_confirm_select(connection_, 1);
            Check(amqp_get_rpc_reply(connection_));
        }
    } catch (...) {
        amqp_destroy_connection(connection_);
        connection_ = nullptr;
        socket_ = -1;
        throw;
    }
}
Queue::~Queue() {
    std::lock_guard<std::mutex> lock(socket_mutex_);
    socket_ = -1;
    if (connection_)
        amqp_destroy_connection(connection_);
}
void Queue::Interrupt() {
    std::lock_guard<std::mutex> lock(socket_mutex_);
    if (socket_ >= 0)
        shutdown(socket_, SHUT_RDWR);
}
void Queue::Publish(const std::string &key) {
    amqp_basic_properties_t props{};
    props._flags = AMQP_BASIC_DELIVERY_MODE_FLAG | AMQP_BASIC_MESSAGE_ID_FLAG;
    props.delivery_mode = 2;
    props.message_id = amqp_cstring_bytes(key.c_str());
    if (amqp_basic_publish(connection_, 1, amqp_empty_bytes, amqp_cstring_bytes(queue_.c_str()), 1,
                           0, &props, amqp_cstring_bytes(key.c_str())) != AMQP_STATUS_OK)
        throw std::runtime_error("RabbitMQ publish failed");
    amqp_frame_t frame;
    timeval timeout{5, 0};
    for (;;) {
        if (amqp_simple_wait_frame_noblock(connection_, &frame, &timeout) != AMQP_STATUS_OK)
            throw std::runtime_error("RabbitMQ confirmation timeout");
        if (frame.frame_type != AMQP_FRAME_METHOD)
            continue;
        if (frame.payload.method.id == AMQP_BASIC_ACK_METHOD)
            return;
        throw std::runtime_error("RabbitMQ publication rejected");
    }
}
std::optional<Delivery> Queue::Next() {
    amqp_envelope_t env;
    timeval timeout{1, 0};
    amqp_maybe_release_buffers(connection_);
    auto reply = amqp_consume_message(connection_, &env, &timeout, 0);
    if (reply.reply_type == AMQP_RESPONSE_LIBRARY_EXCEPTION &&
        reply.library_error == AMQP_STATUS_TIMEOUT)
        return std::nullopt;
    Check(reply);
    Delivery result{std::string(static_cast<char *>(env.message.body.bytes), env.message.body.len),
                    env.delivery_tag};
    amqp_destroy_envelope(&env);
    return result;
}
void Queue::Ack(uint64_t tag) {
    if (amqp_basic_ack(connection_, 1, tag, 0) != AMQP_STATUS_OK)
        throw std::runtime_error("ACK failed");
}
void Queue::Retry(uint64_t tag) {
    if (amqp_basic_nack(connection_, 1, tag, 0, 1) != AMQP_STATUS_OK)
        throw std::runtime_error("NACK failed");
}
} // namespace solo::notify
