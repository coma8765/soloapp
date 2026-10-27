function(solo_api service)
  set(service_dir ${CMAKE_SOURCE_DIR}/services/${service})
  add_custom_command(OUTPUT ${service_dir}/src/generated/api.hpp
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_SOURCE_DIR}/libs/api_codegen/generate.py ${service_dir}
    DEPENDS ${service_dir}/docs/api.yaml ${CMAKE_SOURCE_DIR}/libs/api_codegen/generate.py ${CMAKE_SOURCE_DIR}/libs/api_codegen/route_policy.py VERBATIM)
  add_custom_target(${service}-api DEPENDS ${service_dir}/src/generated/api.hpp)
endfunction()
