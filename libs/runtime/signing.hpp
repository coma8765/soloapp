#pragma once
#include <sodium.h>
#include <fstream>
#include <string>
#include <stdexcept>
#include <ctime>
#include <cstdlib>
inline std::string userSignature(const std::string &id, const std::string &timestamp) {
    const char *path=std::getenv("HMAC_KEY_FILE"); if(!path)throw std::runtime_error("signing key unavailable");
    std::ifstream f(path);std::string encoded;f >> encoded;
    unsigned char key[crypto_auth_hmacsha256_KEYBYTES],mac[crypto_auth_hmacsha256_BYTES];size_t n=0;
    if(encoded.size()!=64 || sodium_hex2bin(key,sizeof(key),encoded.data(),encoded.size(),nullptr,&n,nullptr)!=0 || n!=sizeof(key))throw std::runtime_error("invalid signing key");
    const std::string message="soloapp-user-id:"+id+":"+timestamp;
    crypto_auth_hmacsha256(mac,reinterpret_cast<const unsigned char*>(message.data()),message.size(),key);
    sodium_memzero(key,sizeof(key));sodium_memzero(encoded.data(),encoded.size());
    char out[65];sodium_bin2hex(out,sizeof(out),mac,sizeof(mac));return out;
}
