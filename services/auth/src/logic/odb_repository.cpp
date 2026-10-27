#include "odb_repository.hpp"
#include "generated/odb/entities-odb.hxx"
#include "odb/primary_pool.hpp"
#include <odb/pgsql/exceptions.hxx>
#include <odb/transaction.hxx>
#include <boost/date_time/posix_time/posix_time.hpp>
namespace solo::auth::logic {
OdbRepository::OdbRepository(const std::string& connection_info, const solo::db::PoolConfig& pool)
    : database_(solo::db::PoolConnectionInfo(connection_info, pool),
                std::unique_ptr<odb::pgsql::connection_factory>(new solo::db::PrimaryPool(pool))) {}
std::unique_ptr<odb::transaction> OdbRepository::Begin() {
    return solo::db::BeginPrimary(database_, [&] {
        return database_.query_value<model::WritablePrimary>().writable;
    });
}
bool OdbRepository::CreateUser(const UserRecord& value) {
    try {
        auto tx = Begin();
        model::User user{value.user_id, value.username, value.password_hash};
        database_.persist(user); tx->commit(); return true;
    } catch (const odb::object_already_persistent&) { return false; }
      catch (const odb::pgsql::database_exception& error) {
        if (error.sqlstate() == "23505") return false;
        throw;
    }
}
std::optional<UserRecord> OdbRepository::FindUser(const std::string& username) {
    auto tx = Begin();
    std::unique_ptr<model::User> user(database_.query_one<model::User>(odb::query<model::User>::username == username));
    std::optional<UserRecord> result;
    if (user) result = UserRecord{user->user_id, user->username, user->password_hash};
    tx->commit(); return result;
}
void OdbRepository::CreateSession(const std::string& token_hash, const std::string& user_id) {
    auto tx = Begin();
    model::Session session{token_hash, user_id, boost::posix_time::second_clock::universal_time() + boost::posix_time::hours(24)};
    database_.persist(session); tx->commit();
}
std::optional<std::string> OdbRepository::FindSession(const std::string& token_hash) {
    auto tx = Begin();
    using Query = odb::query<model::Session>;
    std::unique_ptr<model::Session> session(database_.query_one<model::Session>(Query::token_hash == token_hash && Query::expires_at > boost::posix_time::second_clock::universal_time()));
    std::optional<std::string> result;
    if (session) result = session->user_id;
    tx->commit(); return result;
}
void OdbRepository::DeleteSession(const std::string& token_hash) {
    auto tx = Begin();
    database_.erase_query<model::Session>(odb::query<model::Session>::token_hash == token_hash); tx->commit();
}
void OdbRepository::CheckReady() {
    auto tx = Begin();
    database_.query<model::User>(odb::query<model::User>("TRUE LIMIT 1")); tx->commit();
}
}
