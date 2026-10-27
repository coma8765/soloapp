#include "logic/identity.hpp"
#include <json/json.h>
#include <sodium.h>
#include <iostream>
int main() {
    if(sodium_init()<0)return 1;
    Json::Value input,output;std::cin>>input;
    output["verified"]=solo::whoami::logic::VerifyIdentity(input["user_id"].asString(),input["timestamp"].asString(),input["signature"].asString(),input["now"].asInt64());
    std::cout<<output<<std::endl;
}
